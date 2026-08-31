#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const SESSION_TOOLS = new Set(['session_list', 'session_search', 'session_read']);
const args = parseArgs(process.argv.slice(2));
const conversationDir = path.resolve(
  args.conversations ?? path.join(os.homedir(), '.local/share/term2-nodejs/conversations'),
);
const trafficRoot = path.resolve(
  args.traffic ?? path.join(os.homedir(), '.local/state/term2-nodejs/logs/provider-traffic'),
);

const sessionSources = [];
for (const name of (await fs.readdir(conversationDir)).filter((entry) => entry.endsWith('.jsonl')).sort()) {
  const filePath = path.join(conversationDir, name);
  const events = await readJsonLines(filePath);
  const calls = extractSessionCalls(events);
  if (calls.length === 0) continue;

  const init = events.find(({ event }) => event?.type === 'session_init')?.event;
  const firstUserMessage = events.find(({ event }) => event?.type === 'user_message')?.event?.message?.text;
  const fileSessionId = name.slice(0, -'.jsonl'.length);
  const sessionId = typeof init?.id === 'string' ? init.id : fileSessionId;
  sessionSources.push({
    sessionId,
    sourceFile: name,
    projectPath: init?.projectPath ?? null,
    firstUserMessage: typeof firstUserMessage === 'string' ? firstUserMessage : null,
    calls,
    resultByCallId: extractToolResults(events),
    costs: extractCosts(events),
    retrievalTurns: extractRetrievalTurns(events, calls),
  });
}

const traffic = await loadTraffic(trafficRoot, new Set(sessionSources.map(({ sessionId }) => sessionId)));
const sessions = sessionSources.map((source) => {
  const trafficSession = traffic.bySession.get(source.sessionId) ?? { requests: [], indexEntries: [] };
  return {
    sessionId: source.sessionId,
    sourceFile: source.sourceFile,
    projectPath: source.projectPath,
    firstUserMessage: source.firstUserMessage,
    verification: verifySession({
      fileSessionId: source.sourceFile.slice(0, -'.jsonl'.length),
      initSessionId: source.sessionId,
      firstUserMessage: source.firstUserMessage,
      indexEntries: trafficSession.indexEntries,
    }),
    calls: source.calls.map((call) => {
      const result = source.resultByCallId.get(call.callId);
      return {
        ...call,
        executionMs: result?.at ? Math.max(0, timestamp(result.at) - timestamp(call.at)) : null,
        continuationGapMs: toolContinuationGapMs(call, trafficSession.requests),
        result: result
          ? {
              status: result.status,
              chars: result.output.length,
              summary: summarizeSessionResult(result.output),
            }
          : null,
      };
    }),
    session: {
      modelRequests: source.costs.records,
      elapsedMs: trafficElapsedMs(trafficSession.requests),
      usdMicros: source.costs.usdMicros,
      usage: source.costs.usage,
    },
    retrievalTurns: source.retrievalTurns,
  };
});

process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), sessions }, null, 2)}\n`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--conversations' || value === '--traffic') {
      const next = argv[index + 1];
      if (!next) throw new Error(`${value} requires a path`);
      parsed[value.slice(2)] = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}

async function readJsonLines(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  const values = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      // A partial terminal line is not evidence and must not abort the corpus scan.
    }
  }
  return values;
}

function extractSessionCalls(events) {
  return events
    .filter(({ event }) => event?.type === 'tool_started' && SESSION_TOOLS.has(event.toolName))
    .map(({ seq, ts, event }) => ({
      seq,
      at: ts,
      callId: event.toolCallId,
      tool: event.toolName,
      args: event.arguments,
      turnId: event.turnId ?? null,
    }));
}

function extractRetrievalTurns(events, calls) {
  const callsByTurn = Map.groupBy(
    calls.filter(({ turnId }) => turnId),
    ({ turnId }) => turnId,
  );
  const turns = [];
  for (const { ts, event } of events) {
    if (event?.type !== 'assistant_turn' || typeof event.turnId !== 'string') continue;
    const turnCalls = callsByTurn.get(event.turnId);
    if (!turnCalls) continue;
    const costs = sumCostRecords(event.costRecords ?? []);
    const finalText = Array.isArray(event.turn?.items)
      ? event.turn.items
          .filter((item) => item?.type === 'assistant_text' && typeof item.text === 'string')
          .map((item) => item.text)
          .join('\n')
      : '';
    turns.push({
      turnId: event.turnId,
      callCount: turnCalls.length,
      tools: Object.fromEntries(
        [...Map.groupBy(turnCalls, ({ tool }) => tool)].map(([tool, toolCalls]) => [tool, toolCalls.length]),
      ),
      elapsedFromFirstRetrievalMs: Math.max(0, timestamp(ts) - timestamp(turnCalls[0].at)),
      modelRequests: costs.records,
      usdMicros: costs.usdMicros,
      usage: costs.usage,
      finalTextPreview: finalText.replace(/\s+/g, ' ').slice(0, 500),
    });
  }
  return turns;
}

function extractToolResults(events) {
  const results = new Map();
  for (const { ts, event } of events) {
    if (event?.type !== 'command_message' || !SESSION_TOOLS.has(event.message?.toolName)) continue;
    if (typeof event.message.callId !== 'string') continue;
    results.set(event.message.callId, {
      at: ts,
      status: event.message.status ?? 'unknown',
      output:
        typeof event.message.output === 'string' ? event.message.output : JSON.stringify(event.message.output ?? null),
    });
  }
  for (const { event } of events) {
    if (event?.type !== 'assistant_turn' || !Array.isArray(event.turn?.items)) continue;
    for (const item of event.turn.items) {
      if (item?.type !== 'tool_result' || !SESSION_TOOLS.has(item.toolName) || typeof item.callId !== 'string') {
        continue;
      }
      if (results.has(item.callId)) continue;
      results.set(item.callId, {
        at: null,
        status: item.status ?? 'unknown',
        output: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null),
      });
    }
  }
  return results;
}

function summarizeSessionResult(output) {
  try {
    const value = JSON.parse(output);
    if (!value || typeof value !== 'object') return { kind: typeof value };
    return Object.fromEntries(
      ['error', 'total', 'omitted', 'charsUsed', 'nextCursor', 'sessions', 'matches', 'results', 'records']
        .filter((key) => key in value)
        .map((key) => [key, Array.isArray(value[key]) ? value[key].length : value[key]]),
    );
  } catch {
    return { kind: 'text', preview: output.slice(0, 160) };
  }
}

function extractCosts(events) {
  const allRecords = [];
  for (const { event } of events) {
    if (event?.type !== 'assistant_turn' || !Array.isArray(event.costRecords)) continue;
    allRecords.push(...event.costRecords);
  }
  return sumCostRecords(allRecords);
}

function sumCostRecords(costRecords) {
  const result = { records: 0, usdMicros: 0, usage: {} };
  for (const record of costRecords) {
    result.records += 1;
    result.usdMicros += Number(record.usdMicros ?? 0);
    for (const [key, value] of Object.entries(record.usage ?? {})) {
      if (typeof value === 'number') result.usage[key] = (result.usage[key] ?? 0) + value;
    }
  }
  return result;
}

async function loadTraffic(root, wantedSessionIds) {
  const bySession = new Map();
  let days;
  try {
    days = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { bySession };
  }
  for (const day of days.filter((entry) => entry.isDirectory())) {
    const dayPath = path.join(root, day.name);
    for (const entry of await readJsonLinesSafe(path.join(dayPath, 'index.jsonl'))) {
      if (typeof entry.sessionId !== 'string') continue;
      getTrafficSession(bySession, entry.sessionId).indexEntries.push(entry);
    }
    for (const sessionDir of (await fs.readdir(dayPath, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    )) {
      const shortId = sessionDir.name.split('_').at(-1);
      if (![...wantedSessionIds].some((sessionId) => sessionId.startsWith(shortId))) continue;
      const sessionPath = path.join(dayPath, sessionDir.name);
      for (const file of (await fs.readdir(sessionPath)).filter((entry) => entry.endsWith('.json'))) {
        try {
          const envelope = JSON.parse(await fs.readFile(path.join(sessionPath, file), 'utf8'));
          const sessionId = envelope?.sent?.sessionId;
          if (typeof sessionId !== 'string' || !wantedSessionIds.has(sessionId)) continue;
          getTrafficSession(bySession, sessionId).requests.push(envelope);
        } catch {
          // Ignore incomplete traffic artifacts.
        }
      }
    }
  }
  for (const session of bySession.values()) {
    session.requests.sort((left, right) => timestamp(left?.sent?.timestamp) - timestamp(right?.sent?.timestamp));
  }
  return { bySession };
}

async function readJsonLinesSafe(filePath) {
  try {
    return await readJsonLines(filePath);
  } catch {
    return [];
  }
}

function getTrafficSession(bySession, sessionId) {
  let session = bySession.get(sessionId);
  if (!session) {
    session = { requests: [], indexEntries: [] };
    bySession.set(sessionId, session);
  }
  return session;
}

function verifySession({ fileSessionId, initSessionId, firstUserMessage, indexEntries }) {
  const normalizedFirst = normalizePreview(firstUserMessage);
  const matchingIndex = indexEntries.find((entry) => {
    const preview = normalizePreview(entry.firstUserMessagePreview);
    return preview.length > 0 && normalizedFirst.startsWith(preview);
  });
  return {
    fileMatchesInit: typeof initSessionId === 'string' && fileSessionId === initSessionId,
    firstUserMessagePresent: normalizedFirst.length > 0,
    providerIndexMatchesFirstUserMessage: Boolean(matchingIndex),
    providerIndexPreview: matchingIndex?.firstUserMessagePreview ?? null,
  };
}

function normalizePreview(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function toolContinuationGapMs(call, requests) {
  const producingIndex = requests.findIndex((request) =>
    responseToolCalls(request).some((item) => item.id === call.callId),
  );
  if (producingIndex < 0 || producingIndex + 1 >= requests.length) return null;
  const producedAt = timestamp(requests[producingIndex]?.received?.timestamp);
  const continuedAt = timestamp(requests[producingIndex + 1]?.sent?.timestamp);
  return Number.isFinite(producedAt) && Number.isFinite(continuedAt) ? Math.max(0, continuedAt - producedAt) : null;
}

function responseToolCalls(request) {
  const payload = request?.received?.summary?.payload;
  const chatCalls = payload?.choices?.[0]?.delta?.tool_calls ?? [];
  const responseCalls = Array.isArray(payload?.output)
    ? payload.output.filter((item) => item?.type === 'function_call')
    : [];
  return [
    ...chatCalls.map((item) => ({ id: item?.id, name: item?.function?.name })),
    ...responseCalls.map((item) => ({ id: item?.call_id, name: item?.name })),
  ];
}

function trafficElapsedMs(requests) {
  if (requests.length === 0) return null;
  const start = timestamp(requests[0]?.sent?.timestamp);
  const end = timestamp(requests.at(-1)?.received?.timestamp);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function timestamp(value) {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}
