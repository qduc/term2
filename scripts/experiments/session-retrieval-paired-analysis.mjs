#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SESSION_TOOLS = new Set(['session_list', 'session_search', 'session_read']);
const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(
  args.manifest ?? new URL('./session-retrieval-paired-runs.json', import.meta.url).pathname,
);
const conversationDir = path.resolve(
  args.conversations ?? path.join(os.homedir(), '.local/share/term2-nodejs/conversations'),
);
const trafficRoot = path.resolve(
  args.traffic ?? path.join(os.homedir(), '.local/state/term2-nodejs/logs/provider-traffic'),
);
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const cells = manifest.tasks.flatMap((task) => task.cells.map((cell) => ({ task: task.id, ...cell })));
const traffic = await loadTraffic(trafficRoot, new Set(cells.map(({ sessionId }) => sessionId)));
const results = [];

for (const cell of cells) {
  const sourceFile = path.join(conversationDir, `${cell.sessionId}.jsonl`);
  const events = await readJsonLines(sourceFile);
  const init = events.find(({ event }) => event?.type === 'session_init')?.event;
  const firstUserMessage = events.find(({ event }) => event?.type === 'user_message')?.event?.message?.text ?? null;
  const continuation = [...events].reverse().find(({ event }) => {
    if (event?.type !== 'user_message' || typeof event.message?.text !== 'string') return false;
    if (cell.continuationEquals !== undefined) return event.message.text.trim() === cell.continuationEquals;
    return event.message.text.startsWith(cell.continuationStartsWith);
  });
  if (!continuation) throw new Error(`Continuation prompt not found for ${cell.task}/${cell.flow}`);

  const continuationEvents = events.filter(({ seq }) => seq >= continuation.seq);
  const calls = extractSessionCalls(continuationEvents);
  const toolResults = extractToolResults(continuationEvents);
  const assistantTurns = continuationEvents.filter(({ event }) => event?.type === 'assistant_turn');
  const finalText = assistantTurns
    .flatMap(({ event }) => event.turn?.items ?? [])
    .filter((item) => item?.type === 'assistant_text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  const costs = sumCostRecords(assistantTurns.flatMap(({ event }) => event.costRecords ?? []));
  const trafficSession = traffic.bySession.get(cell.sessionId) ?? { indexEntries: [], requests: [] };
  const continuationRequests = trafficSession.requests.filter(
    (request) => timestamp(request?.sent?.timestamp) >= timestamp(continuation.ts),
  );
  const evaluatorStatus = cell.evaluatorStatus ? (await readTextSafe(cell.evaluatorStatus)).trim() || null : null;

  results.push({
    task: cell.task,
    flow: cell.flow,
    sessionId: cell.sessionId,
    sourceFile: path.basename(sourceFile),
    projectPath: init?.projectPath ?? null,
    firstUserMessage,
    continuation: {
      seq: continuation.seq,
      at: continuation.ts,
      text: continuation.event.message.text,
    },
    verification: verifySession({
      fileSessionId: path.basename(sourceFile, '.jsonl'),
      initSessionId: init?.id,
      firstUserMessage,
      indexEntries: trafficSession.indexEntries,
    }),
    configured: {
      provider: init?.provider ?? null,
      model: init?.model ?? null,
      effort: init?.reasoningEffort ?? null,
    },
    observedTraffic: {
      providers: [...new Set(continuationRequests.map((request) => request?.sent?.provider).filter(Boolean))],
      models: [...new Set(continuationRequests.map((request) => request?.sent?.model).filter(Boolean))],
      requests: continuationRequests.length,
      elapsedMs: trafficElapsedMs(continuationRequests),
    },
    calls: calls.map((call) => {
      const result = toolResults.get(call.callId);
      return {
        ...call,
        executionMs: result?.at ? Math.max(0, timestamp(result.at) - timestamp(call.at)) : null,
        result: result
          ? {
              status: result.status,
              chars: result.output.length,
              summary: summarizeSessionResult(result.output),
            }
          : null,
      };
    }),
    continuationCost: costs,
    outcome: {
      deterministicOracle: cell.oracleIncludes.every((needle) => finalText.includes(needle)) ? 'PASS' : 'FAIL',
      missingOracleStrings: cell.oracleIncludes.filter((needle) => !finalText.includes(needle)),
      evaluatorStatus,
      finalText,
    },
  });
}

process.stdout.write(
  `${JSON.stringify(
    { generatedAt: new Date().toISOString(), manifest: path.basename(manifestPath), results },
    null,
    2,
  )}\n`,
);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--manifest' || value === '--conversations' || value === '--traffic') {
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
  return text
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

async function readTextSafe(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
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
  return results;
}

function sumCostRecords(records) {
  const result = { records: 0, usdMicros: 0, usage: {} };
  for (const record of records) {
    result.records += 1;
    result.usdMicros += Number(record.usdMicros ?? 0);
    for (const [key, value] of Object.entries(record.usage ?? {})) {
      if (typeof value === 'number') result.usage[key] = (result.usage[key] ?? 0) + value;
    }
  }
  return result;
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

async function loadTraffic(root, wantedSessionIds) {
  const bySession = new Map();
  for (const day of await fs.readdir(root, { withFileTypes: true })) {
    if (!day.isDirectory()) continue;
    const dayPath = path.join(root, day.name);
    for (const entry of await readJsonLinesSafe(path.join(dayPath, 'index.jsonl'))) {
      if (!wantedSessionIds.has(entry.sessionId)) continue;
      getTrafficSession(bySession, entry.sessionId).indexEntries.push(entry);
    }
    for (const sessionDir of await fs.readdir(dayPath, { withFileTypes: true })) {
      if (!sessionDir.isDirectory()) continue;
      const shortId = sessionDir.name.split('_').at(-1);
      const sessionId = [...wantedSessionIds].find((id) => id.startsWith(shortId));
      if (!sessionId) continue;
      const sessionPath = path.join(dayPath, sessionDir.name);
      for (const file of (await fs.readdir(sessionPath)).filter((entry) => entry.endsWith('.json'))) {
        try {
          const envelope = JSON.parse(await fs.readFile(path.join(sessionPath, file), 'utf8'));
          if (envelope?.sent?.sessionId !== sessionId) continue;
          getTrafficSession(bySession, sessionId).requests.push(envelope);
        } catch {
          // Ignore incomplete provider-traffic files.
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

function trafficElapsedMs(requests) {
  if (requests.length === 0) return null;
  const start = timestamp(requests[0]?.sent?.timestamp);
  const end = timestamp(requests.at(-1)?.received?.timestamp);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function timestamp(value) {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}
