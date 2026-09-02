#!/usr/bin/env node
/**
 * Controlled seek/tail cell driver.
 *
 * Reproduces the naturalistic "invented cursor / no tail page" defect shape
 * from docs/research/session-retrieval-observed-usage.md:
 *
 *   predecessor is long → the needed fact is only in the last projected
 *   record → session_read starts at index 0 and has no from-end / numeric
 *   seek → the agent walks many pages and/or invents cursor: "40".
 *
 * Usage:
 *   node scripts/experiments/session-retrieval-seek-cell.mjs \
 *     --cli /home/qduc/term2/dist/cli.js \
 *     --bench /home/qduc/.agents/runtime/bench-session-seek-<ts> \
 *     --label control [--timeout-secs 1800] [--skip-seed] [--seed-id <id>] [--no-cell]
 *
 * Writes <bench>/<label>.result.json with seed ID, token, cell session ID,
 * session-tool call log, defect metrics, and oracle verdict.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONVERSATIONS_DIR = path.join(os.homedir(), '.local/share/term2-nodejs/conversations');
const HERDR_WORKSPACE = 'w1';
const MODEL = 'gpt-5.6-luna';
const PROVIDER = 'codex';
const EFFORT = 'medium';
const PAIR_COUNT = 30;
const FILLER_CHARS = 1_800;
const MAX_SESSION_BROWSER_CHARS = 12_000;
const HANDLE_RE = /^c[0-9a-z]+$/;
const TOKEN_RE = /\b[0-9a-f]{32}\b/;
const SESSION_TOOLS = new Set(['session_list', 'session_search', 'session_read']);

function parseArgs(argv) {
  const args = { timeoutSecs: 1800 };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (
      value === '--cli' ||
      value === '--bench' ||
      value === '--label' ||
      value === '--timeout-secs' ||
      value === '--seed-id'
    ) {
      const next = argv[i + 1];
      if (!next) throw new Error(`${value} requires a value`);
      if (value === '--timeout-secs') args.timeoutSecs = Number(next);
      else if (value === '--seed-id') args.seedId = next;
      else args[value.slice(2)] = next;
      i += 1;
    } else if (value === '--skip-seed') {
      args.skipSeed = true;
    } else if (value === '--no-cell') {
      args.noCell = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!args.cli || !args.bench || !args.label) {
    throw new Error('--cli, --bench, and --label are required');
  }
  return args;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 600_000, ...opts });
  if (result.error) throw new Error(`${cmd} spawn failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${result.status}: ${(result.stderr || result.stdout).slice(0, 2000)}`,
    );
  }
  return result.stdout;
}

function herdr(...args) {
  const result = spawnSync('herdr', args, { encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) {
    throw new Error(`herdr ${args.join(' ')} exited ${result.status}: ${(result.stderr || '').slice(0, 2000)}`);
  }
  const out = (result.stdout || '').trim();
  if (!out) return {};
  try {
    return JSON.parse(out);
  } catch {
    return { _raw: out };
  }
}

function sleep(ms) {
  spawnSync('sleep', [String(Math.ceil(ms / 1000))], { encoding: 'utf8' });
}

function readJsonLines(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
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

function sessionInitProjectPath(conversationId) {
  const file = path.join(CONVERSATIONS_DIR, `${conversationId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const init = readJsonLines(file).find(({ event }) => event?.type === 'session_init')?.event;
  return typeof init?.projectPath === 'string' ? init.projectPath : null;
}

function listProjectSessions(projectPath) {
  const normalized = path.normalize(projectPath);
  const result = [];
  for (const entry of fs.readdirSync(CONVERSATIONS_DIR)) {
    if (!entry.endsWith('.jsonl')) continue;
    const id = entry.slice(0, -'.jsonl'.length);
    const file = path.join(CONVERSATIONS_DIR, entry);
    if (path.normalize(sessionInitProjectPath(id) ?? '') === normalized) {
      result.push({ id, file, mtimeMs: fs.statSync(file).mtimeMs });
    }
  }
  return result.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function firstUserMessage(conversationId) {
  const file = path.join(CONVERSATIONS_DIR, `${conversationId}.jsonl`);
  const event = readJsonLines(file).find(({ event }) => event?.type === 'user_message')?.event;
  return typeof event?.message?.text === 'string' ? event.message.text : null;
}

function assistantTexts(conversationId) {
  const file = path.join(CONVERSATIONS_DIR, `${conversationId}.jsonl`);
  return readJsonLines(file)
    .filter(({ event }) => event?.type === 'assistant_turn')
    .map(({ event }) =>
      (event.turn?.items ?? [])
        .filter((item) => item?.type === 'assistant_text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('\n'),
    );
}

function extractToken(conversationId) {
  const texts = assistantTexts(conversationId);
  const last = texts.at(-1) ?? '';
  const match = last.trim().match(TOKEN_RE);
  return match && last.trim() === match[0] ? match[0] : null;
}

function extractSessionCalls(conversationId) {
  const file = path.join(CONVERSATIONS_DIR, `${conversationId}.jsonl`);
  const calls = [];
  const results = new Map();
  for (const { event } of readJsonLines(file)) {
    if (event?.type === 'tool_started' && SESSION_TOOLS.has(event.toolName)) {
      calls.push({
        callId: event.toolCallId ?? null,
        tool: event.toolName,
        args: event.arguments,
        turnId: event.turnId ?? null,
        result: null,
      });
    }
    if (event?.type === 'command_message' && SESSION_TOOLS.has(event.message?.toolName)) {
      if (typeof event.message.callId !== 'string') continue;
      results.set(event.message.callId, {
        status: event.message.status ?? 'unknown',
        output:
          typeof event.message.output === 'string'
            ? event.message.output
            : JSON.stringify(event.message.output ?? null),
      });
    }
  }
  for (const call of calls) {
    if (call.callId && results.has(call.callId)) call.result = results.get(call.callId);
  }
  return calls;
}

function summarizeCall(call) {
  const output = call.result?.output ?? '';
  let parsed = null;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = null;
  }
  return {
    tool: call.tool,
    args: call.args,
    status: call.result?.status ?? null,
    error:
      parsed?.error ??
      (typeof output === 'string' && output.includes('did not match schema') ? { code: 'schema' } : null),
    total: parsed?.total,
    omitted: parsed?.omitted,
    nextCursor: parsed?.nextCursor,
    outputPreview: output.slice(0, 240),
  };
}

function defectMetrics(calls, token) {
  const reads = calls.filter((call) => call.tool === 'session_read');
  const invented = [];
  const schema = [];
  let invalidCursor = 0;
  let reachedToken = false;
  for (const call of calls) {
    const args = call.args ?? {};
    const summary = summarizeCall(call);
    if (args.cursor != null && args.cursor !== '' && !HANDLE_RE.test(String(args.cursor))) {
      invented.push(String(args.cursor));
    }
    if (
      (typeof args.maxChars === 'number' && args.maxChars > 12_000) ||
      (typeof args.limit === 'number' && args.limit > 50)
    ) {
      schema.push({ tool: call.tool, maxChars: args.maxChars, limit: args.limit });
    }
    if (summary.error?.code === 'invalid_cursor') invalidCursor += 1;
    if (summary.error?.code === 'schema') schema.push({ tool: call.tool, via: 'result' });
    if (typeof call.result?.output === 'string' && token && call.result.output.includes(token)) reachedToken = true;
  }
  const firstSeedRead = reads[0] ? summarizeCall(reads[0]) : null;
  return {
    sessionRead: reads.length,
    sessionSearch: calls.filter((call) => call.tool === 'session_search').length,
    sessionList: calls.filter((call) => call.tool === 'session_list').length,
    invalidCursor,
    inventedCursors: invented,
    schemaBoundary: schema,
    reachedToken,
    firstReadOmitted: firstSeedRead?.omitted ?? null,
    reproduced: reads.length >= 5 || invented.length > 0 || invalidCursor > 0,
  };
}

function finalText(conversationId) {
  const file = path.join(CONVERSATIONS_DIR, `${conversationId}.jsonl`);
  return readJsonLines(file)
    .filter(({ event }) => event?.type === 'assistant_turn')
    .flatMap(({ event }) => event.turn?.items ?? [])
    .filter((item) => item?.type === 'assistant_text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function setupBench(bench) {
  if (fs.existsSync(path.join(bench, '.git'))) return;
  fs.mkdirSync(bench, { recursive: true });
  fs.writeFileSync(
    path.join(bench, 'README.md'),
    'Throwaway bench for the session-retrieval seek/tail cell. Not a product repo.\n',
  );
  run('git', ['init', '-b', 'main'], { cwd: bench });
  run('git', ['config', 'user.email', 'cell@local'], { cwd: bench });
  run('git', ['config', 'user.name', 'session-seek-cell'], { cwd: bench });
  run('git', ['add', '.'], { cwd: bench });
  run('git', ['commit', '-m', 'seek-cell bench'], { cwd: bench });
}

function fillerText(index, token) {
  const unit = `Filler block ${String(index).padStart(2, '0')} of a long predecessor transcript. `;
  let text = unit.repeat(Math.ceil(FILLER_CHARS / unit.length)).slice(0, FILLER_CHARS);
  if (text.includes(token)) throw new Error('filler collided with token');
  return text;
}

function writeSeed(bench) {
  const seedId = randomUUID();
  let token = randomBytes(16).toString('hex');
  const createdAt = '2026-09-02T00:00:00.000Z';
  const lines = [];
  let seq = 1;
  const push = (event, ts) => {
    lines.push(JSON.stringify({ v: 3, seq, ts, event }));
    seq += 1;
  };
  push(
    {
      type: 'session_init',
      id: seedId,
      createdAt,
      projectPath: bench,
      model: 'seek-cell-seed',
      provider: 'none',
    },
    createdAt,
  );
  for (let i = 1; i <= PAIR_COUNT; i += 1) {
    const ts = `2026-09-02T00:${String(i).padStart(2, '0')}:00.000Z`;
    const userText = i === 1 ? `seek-cell seed ${seedId}` : 'continue';
    const assistantText = i === PAIR_COUNT ? token : fillerText(i, token);
    push({ type: 'user_message', message: { id: `${seedId}-u${i}`, sender: 'user', text: userText } }, ts);
    push(
      {
        type: 'assistant_turn',
        turn: { items: [{ type: 'assistant_text', text: assistantText }] },
        state: { previousResponseId: null },
      },
      ts,
    );
  }
  const priorText = Array.from({ length: PAIR_COUNT - 1 }, (_, i) => fillerText(i + 1, token)).join('');
  if (priorText.length <= MAX_SESSION_BROWSER_CHARS) {
    throw new Error(`seed prior text ${priorText.length} is not larger than the 12k first-page budget`);
  }
  const file = path.join(CONVERSATIONS_DIR, `${seedId}.jsonl`);
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const extracted = extractToken(seedId);
  if (extracted !== token) throw new Error(`seed token mismatch: wrote ${token}, read ${extracted}`);
  const all = fs.readFileSync(file, 'utf8');
  if (all.split(token).length !== 2) throw new Error('token is not unique in the seed file');
  return { seedId, token, records: PAIR_COUNT * 2, priorChars: priorText.length };
}

function taskPrompt(seedId) {
  return (
    `Previous session ID: \`${seedId}\`.\n\n` +
    `That session's last assistant message is exactly one 32-character lowercase hexadecimal confirmation code and nothing else. ` +
    `Recover that code using the session tools (session_read / session_search / session_list). ` +
    `Report only the code in your final answer. Do not modify files.`
  );
}

function agentStatus(name) {
  const got = herdr('agent', 'get', name);
  const agent = got?.result?.agent ?? got?.result ?? {};
  return agent.agent_status ?? agent.status ?? got.agent_status ?? 'unknown';
}

function waitForAgent(name, timeoutSecs) {
  const deadline = Date.now() + timeoutSecs * 1000;
  while (Date.now() < deadline) {
    const status = agentStatus(name);
    if (status !== 'unknown') return status;
    sleep(2_000);
  }
  return 'unknown';
}

function settleAgent(name, timeoutSecs) {
  const deadline = Date.now() + timeoutSecs * 1000;
  let sawWorking = false;
  while (Date.now() < deadline) {
    const status = agentStatus(name);
    if (status === 'blocked') return 'blocked';
    if (status === 'working') sawWorking = true;
    if (
      (status === 'idle' || status === 'done') &&
      (sawWorking || Date.now() - deadline + timeoutSecs * 1000 > 90_000)
    ) {
      return status;
    }
    sleep(5_000);
  }
  return 'timeout';
}

function runCell(cli, bench, label, timeoutSecs, message) {
  const tab = herdr(
    'tab',
    'create',
    '--workspace',
    HERDR_WORKSPACE,
    '--cwd',
    bench,
    '--label',
    `seek-${label}`,
    '--no-focus',
  );
  const tabResult = tab.result ?? tab;
  const tabId = (tabResult.tab ?? {}).tab_id;
  const paneId = (tabResult.root_pane ?? {}).pane_id;
  if (!paneId) throw new Error(`could not read root pane: ${JSON.stringify(tab)}`);
  const agentName = `bench-seek-${label}`;
  const cellStart = Date.now();

  try {
    herdr('pane', 'run', paneId, `node ${cli} -p ${PROVIDER} -m ${MODEL} -r ${EFFORT}`);
    sleep(8_000);
    herdr('agent', 'rename', paneId, agentName);
    const bootStatus = waitForAgent(agentName, 60);
    const phaseStates = [bootStatus];
    const clean = message.split(/\s+/).filter(Boolean).join(' ');
    herdr('pane', 'run', paneId, clean);
    sleep(1_000);
    herdr('pane', 'send-keys', paneId, 'enter');
    phaseStates.push(settleAgent(agentName, timeoutSecs));
    sleep(3_000);
    const read = herdr(
      'agent',
      'read',
      agentName,
      '--source',
      'recent-unwrapped',
      '--lines',
      '400',
      '--format',
      'text',
    );
    const transcript = read?.result?.text ?? read?.text ?? read?._raw ?? JSON.stringify(read);
    const candidates = listProjectSessions(bench).filter(({ mtimeMs }) => mtimeMs >= cellStart - 5_000);
    const cellSession = candidates[candidates.length - 1];
    if (!cellSession)
      throw new Error(`cell session not found under project ${bench}; transcript head:\n${transcript.slice(0, 1500)}`);
    return { tabId, paneId, agentName, phaseStates, sessionId: cellSession.id, transcript };
  } finally {
    if (tabId) herdr('tab', 'close', tabId);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const bench = path.resolve(args.bench);
  setupBench(bench);

  let seedId = null;
  let token = null;
  let seedMeta = null;
  if (!args.skipSeed && !args.seedId) {
    seedMeta = writeSeed(bench);
    seedId = seedMeta.seedId;
    token = seedMeta.token;
    console.log(`seed: ${seedId} token: ${token} records: ${seedMeta.records} priorChars: ${seedMeta.priorChars}`);
  } else {
    if (args.seedId) {
      seedId = args.seedId;
      token = extractToken(seedId);
      if (!token) throw new Error(`--seed-id ${seedId} does not contain a valid final 32-hex assistant token`);
      console.log(`reused seed: ${seedId} token: ${token}`);
    } else {
      const sessions = listProjectSessions(bench);
      const seed = [...sessions].reverse().find((candidate) => extractToken(candidate.id));
      if (!seed) throw new Error('--skip-seed but no bench-born session with a 32-hex last assistant found');
      seedId = seed.id;
      token = extractToken(seed.id);
      console.log(`reused seed: ${seedId} token: ${token}`);
    }
  }

  if (args.noCell) {
    console.log(JSON.stringify({ bench, label: args.label, seedId, token, seed: seedMeta }, null, 2));
    return;
  }

  const cell = runCell(args.cli, bench, args.label, args.timeoutSecs, taskPrompt(seedId));
  const calls = extractSessionCalls(cell.sessionId);
  const text = finalText(cell.sessionId);
  const oraclePass = typeof token === 'string' && text.includes(token);
  const defects = defectMetrics(calls, token);

  const result = {
    generatedAt: new Date().toISOString(),
    label: args.label,
    cli: args.cli,
    bench,
    model: `${PROVIDER}/${MODEL}`,
    effort: EFFORT,
    seed: {
      sessionId: seedId,
      token,
      firstUserMessage: firstUserMessage(seedId),
      ...seedMeta,
    },
    cell: {
      sessionId: cell.sessionId,
      firstUserMessage: firstUserMessage(cell.sessionId)?.slice(0, 200),
      phaseStates: cell.phaseStates,
      sessionCalls: calls.map(summarizeCall),
    },
    defects,
    oracle: { pass: oraclePass, token, missing: !oraclePass },
    finalText: text,
  };
  const outPath = path.join(bench, `${args.label}.result.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  console.log(
    `cell ${args.label}: session ${cell.sessionId} state ${cell.phaseStates.at(-1)} oracle ${
      oraclePass ? 'PASS' : 'FAIL'
    } reproduced ${defects.reproduced}`,
  );
  console.log(`result: ${outPath}`);
}

main();
