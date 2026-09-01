#!/usr/bin/env node
/**
 * Controlled session-scope repair cell driver.
 *
 * Reproduces the naturalistic "worktree re-scoping" defect shape from
 * docs/research/session-retrieval-observed-usage.md (Pattern 1):
 *
 *   session born in project P -> agent enters a git worktree of P ->
 *   agent needs prior-session state -> session_list/search/read resolve
 *   their corpus from the live cwd and return total:0 / not_found.
 *
 * The cell is a two-message interactive session:
 *   1. create + enter a git worktree of the bench repo (enter_worktree);
 *   2. recover a token that exists ONLY in a seed session's transcript
 *      (S0, persisted under P) using the session tools, then complete a
 *      trivial fix inside the worktree and report the token.
 *
 * Run the same bench dir twice: --label control against the pre-repair
 * build, then --label repair against the post-repair build.
 *
 * Usage:
 *   node scripts/experiments/session-retrieval-scope-cell.mjs \
 *     --cli /home/qduc/term2/dist/cli.js \
 *     --bench /home/qduc/.agents/runtime/bench-session-scope-<ts> \
 *     --label control [--timeout-secs 1200] [--skip-seed] [--no-cell]
 *
 * Writes <bench>/<label>.result.json with the seed ID, oracle token, cell
 * session ID, session-tool call log, and oracle verdict.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONVERSATIONS_DIR = path.join(os.homedir(), '.local/share/term2-nodejs/conversations');
const HERDR_WORKSPACE = 'w1';
const MODEL = 'gpt-5.6-luna';
const PROVIDER = 'codex';
const EFFORT = 'medium';
const TOKEN_PATTERN = /oracle-[0-9a-f]{32}/;

const SEED_PROMPT =
  'Run this exact shell command unchanged (do not modify it, do not redirect its output, do not save it to a file):\n' +
  'node -e \'console.log("oracle-" + require("crypto").randomBytes(16).toString("hex"))\'\n' +
  'Then repeat the exact output of that command verbatim in your final answer. Do not add anything else to your final answer beyond that token and one short confirmation line.';

function parseArgs(argv) {
  const args = { timeoutSecs: 1200 };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--cli' || value === '--bench' || value === '--label' || value === '--timeout-secs') {
      const next = argv[i + 1];
      if (!next) throw new Error(`${value} requires a value`);
      if (value === '--timeout-secs') args.timeoutSecs = Number(next);
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
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}: ${(result.stderr || result.stdout).slice(0, 2000)}`);
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

function extractToken(conversationId) {
  const file = path.join(CONVERSATIONS_DIR, `${conversationId}.jsonl`);
  for (const { event } of readJsonLines(file)) {
    if (event?.type !== 'command_message') continue;
    const output = typeof event.message?.output === 'string' ? event.message.output : '';
    const match = output.match(TOKEN_PATTERN);
    if (match) return match[0];
  }
  // Fall back to assistant text: a seed may report the token in its reply.
  for (const { event } of readJsonLines(file)) {
    if (event?.type !== 'assistant_turn') continue;
    const text = (event.turn?.items ?? [])
      .filter((item) => item?.type === 'assistant_text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
    const match = text.match(TOKEN_PATTERN);
    if (match) return match[0];
  }
  return null;
}

function extractSessionCalls(conversationId) {
  const file = path.join(CONVERSATIONS_DIR, `${conversationId}.jsonl`);
  const calls = [];
  const results = new Map();
  for (const { event } of readJsonLines(file)) {
    if (event?.type === 'tool_started' && ['session_list', 'session_search', 'session_read'].includes(event.toolName)) {
      calls.push({
        callId: event.toolCallId ?? null,
        tool: event.toolName,
        args: event.arguments,
        turnId: event.turnId ?? null,
        result: null,
      });
    }
    if (event?.type === 'command_message' && ['session_list', 'session_search', 'session_read'].includes(event.message?.toolName)) {
      if (typeof event.message.callId !== 'string') continue;
      results.set(event.message.callId, {
        status: event.message.status ?? 'unknown',
        output: typeof event.message.output === 'string' ? event.message.output.slice(0, 600) : JSON.stringify(event.message.output ?? null),
      });
    }
  }
  for (const call of calls) {
    if (call.callId && results.has(call.callId)) {
      call.result = results.get(call.callId);
    }
  }
  return calls;
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
  if (!fs.existsSync(path.join(bench, '.git'))) {
    fs.mkdirSync(bench, { recursive: true });
    fs.writeFileSync(
      path.join(bench, 'package.json'),
      JSON.stringify({ name: 'session-scope-cell', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
    );
    fs.mkdirSync(path.join(bench, 'src'), { recursive: true });
    fs.writeFileSync(path.join(bench, 'src', 'greet.mjs'), 'export function greet(name) {\n  return `Hi, ${name}!`;\n}\n');
    fs.mkdirSync(path.join(bench, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(bench, 'test', 'greet.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greet.mjs';\n\ntest('greet returns a hello greeting', () => {\n  assert.equal(greet('world'), 'Hello, world!');\n});\n",
    );
    run('git', ['init', '-b', 'main'], { cwd: bench });
    run('git', ['config', 'user.email', 'cell@local'], { cwd: bench });
    run('git', ['config', 'user.name', 'session-scope-cell'], { cwd: bench });
    run('git', ['add', '.'], { cwd: bench });
    run('git', ['commit', '-m', 'initial broken greet'], { cwd: bench });
    // Sanity: the fixture must fail before the fix.
    const test = spawnSync('node', ['--test'], { cwd: bench, encoding: 'utf8' });
    if (test.status === 0) throw new Error('bench fixture passes tests before the fix; oracle is void');
  }
}

function runSeed(cli, bench) {
  // Non-interactive runs are never persisted, so the seed is a short
  // interactive cell: one message, then the tab is closed.
  const { sessionId } = runCell(cli, bench, null, 'seed', 600, [SEED_PROMPT]);
  const seed = listProjectSessions(bench).find(({ id }) => id === sessionId) ?? null;
  if (!seed) throw new Error(`seed session ${sessionId} not found under project ${bench}`);
  const token = extractToken(seed.id);
  if (!token) throw new Error(`no oracle token found in seed session ${seed.id}`);
  return { seedId: seed.id, token };
}

function cellPrompt(seedId) {
  return (
    `Set up for a continuation: create a git worktree of this repository at .worktrees/session-scope-fix ` +
    `(git worktree add .worktrees/session-scope-fix -b session-scope-fix), then switch into it with the ` +
    `enter_worktree tool. Confirm you are working inside the worktree, then stop and wait for the next instruction.`
  );
}

function taskPrompt(seedId) {
  return (
    `Continue the interrupted session.\n\nPrevious session ID: \`${seedId}\`.\n\n` +
    `The previous session generated a unique recovery token that this continuation must use. Recover the exact token ` +
    `from that session's transcript using the session tools (session_read / session_search). Then complete the pending ` +
    `fix inside the worktree you are in: src/greet.mjs returns the wrong greeting and test/greet.test.mjs fails under ` +
    '`node --test`. Fix it so the test passes, commit the fix in the worktree with the recovered token as the commit-message ' +
    'suffix (e.g. `fix greet: <token>`), and report the recovered token in your final answer.'
  );
}

function agentStatus(name) {
  const got = herdr('agent', 'get', name);
  const agent = got?.result?.agent ?? got?.result ?? {};
  return agent.agent_status ?? agent.status ?? got.agent_status ?? 'unknown';
}

function waitForAgent(name, timeoutSecs) {
  const deadline = Date.now() + timeoutSecs * 1000;
  // Wait for the term2 app to boot and be recognized.
  while (Date.now() < deadline) {
    const status = agentStatus(name);
    if (status !== 'unknown') return status;
    sleep(2_000);
  }
  return 'unknown';
}

// Settle a submitted prompt: require the agent to have entered 'working'
// (turn admitted) before accepting idle/done, mirroring herdr-run.py. A bare
// `agent wait` returns immediately when term2 is already idle at its prompt,
// which would close the tab mid-turn.
function settleAgent(name, timeoutSecs) {
  const deadline = Date.now() + timeoutSecs * 1000;
  let sawWorking = false;
  while (Date.now() < deadline) {
    const status = agentStatus(name);
    if (status === 'blocked') return 'blocked';
    if (status === 'working') sawWorking = true;
    if ((status === 'idle' || status === 'done') && (sawWorking || Date.now() - deadline + timeoutSecs * 1000 > 90_000)) {
      return status;
    }
    sleep(5_000);
  }
  return 'timeout';
}

function runCell(cli, bench, seedId, label, timeoutSecs, messages) {
  const tab = herdr('tab', 'create', '--workspace', HERDR_WORKSPACE, '--cwd', bench, '--label', `scope-${label}`, '--no-focus');
  const tabResult = tab.result ?? tab;
  const tabId = (tabResult.tab ?? {}).tab_id;
  const paneId = (tabResult.root_pane ?? {}).pane_id;
  if (!paneId) throw new Error(`could not read root pane: ${JSON.stringify(tab)}`);
  const agentName = `bench-scope-${label}`;
  const cellStart = Date.now();

  try {
    herdr('pane', 'run', paneId, `node ${cli} -p ${PROVIDER} -m ${MODEL} -r ${EFFORT}`);
    sleep(8_000);
    herdr('agent', 'rename', paneId, agentName);
    const bootStatus = waitForAgent(agentName, 60);
    const phaseStates = [bootStatus];

    for (const [index, message] of messages.entries()) {
      const clean = message.split(/\s+/).filter(Boolean).join(' ');
      herdr('pane', 'run', paneId, clean);
      sleep(1_000);
      herdr('pane', 'send-keys', paneId, 'enter');
      phaseStates.push(settleAgent(agentName, timeoutSecs));
    }

    sleep(3_000);
    const read = herdr('agent', 'read', agentName, '--source', 'recent-unwrapped', '--lines', '400', '--format', 'text');
    const transcript = read?.result?.text ?? read?.text ?? read?._raw ?? JSON.stringify(read);

    const candidates = listProjectSessions(bench).filter(({ mtimeMs }) => mtimeMs >= cellStart - 5_000);
    const cellSession = candidates[candidates.length - 1];
    if (!cellSession) throw new Error(`cell session not found under project ${bench}; transcript head:\n${transcript.slice(0, 1500)}`);

    return {
      tabId,
      paneId,
      agentName,
      phaseStates,
      sessionId: cellSession.id,
      transcript,
    };
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
  if (!args.skipSeed) {
    const seeded = runSeed(args.cli, bench);
    seedId = seeded.seedId;
    token = seeded.token;
    console.log(`seed: ${seedId} token: ${token}`);
  } else {
    // --skip-seed: reuse the most recent bench-born session that carries a token.
    const sessions = listProjectSessions(bench);
    const seed = [...sessions].reverse().find((candidate) => extractToken(candidate.id));
    if (!seed) throw new Error('--skip-seed but no bench-born session with an oracle token found');
    seedId = seed.id;
    token = extractToken(seed.id);
    console.log(`reused seed: ${seedId} token: ${token}`);
  }

  if (args.noCell) {
    console.log(JSON.stringify({ bench, label: args.label, seedId, token }, null, 2));
    return;
  }

  const cell = runCell(args.cli, bench, seedId, args.label, args.timeoutSecs, [cellPrompt(seedId), taskPrompt(seedId)]);
  const calls = extractSessionCalls(cell.sessionId);
  const text = finalText(cell.sessionId);
  const oraclePass = typeof token === 'string' && text.includes(token);

  const result = {
    generatedAt: new Date().toISOString(),
    label: args.label,
    cli: args.cli,
    bench,
    model: `${PROVIDER}/${MODEL}`,
    effort: EFFORT,
    seed: { sessionId: seedId, token, firstUserMessage: firstUserMessage(seedId)?.slice(0, 200) },
    cell: {
      sessionId: cell.sessionId,
      firstUserMessage: firstUserMessage(cell.sessionId)?.slice(0, 200),
      phaseStates: cell.phaseStates,
      sessionCalls: calls,
    },
    oracle: { pass: oraclePass, token, missing: !oraclePass },
    finalText: text,
  };
  const outPath = path.join(bench, `${args.label}.result.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`cell ${args.label}: session ${cell.sessionId} state ${cell.phaseStates.at(-1)} oracle ${oraclePass ? 'PASS' : 'FAIL'}`);
  console.log(`result: ${outPath}`);
}

main();
