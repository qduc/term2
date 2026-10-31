#!/usr/bin/env node
// M1 executable bench: m1-draft.md §9 table D (rows 1-12) plus flag and interactive-terminal
// checks from §5. It spawns the built headless executable against a local fake OpenAI-compatible
// provider, and drives the public session API in-process for follow-ups, reopen and failure
// injection. Written against the approved behaviour and the frozen interfaces, not against
// any implementation.
//
//   node rewrite/scripts/build.mjs && node rewrite/bench/m1-direct.mjs
//
// A row is BLOCKED, not PASS, when it reaches a frozen stub that is still unimplemented, so an
// unfinished CLI or session layer can never pass by accident. Exit 0 only when every row passes.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(repo, 'rewrite/dist/rewrite/src');
const CLI = path.join(dist, 'app/cli.js');
const STUB = 'the direct headless path is not implemented yet';

if (!fs.existsSync(CLI)) {
  console.error(`missing ${path.relative(repo, CLI)}; build first: node rewrite/scripts/build.mjs`);
  process.exit(2);
}

const dynamic = (rel) => import(pathToFileURL(path.join(dist, rel)).href);
const { createLog, openLog, readFacts } = await dynamic('session/log.js');
const { replay } = await dynamic('session/replay.js');
const { createConversation, openConversation } = await dynamic('session/conversation.js');

const MODEL = { provider: 'mockprov', model: 'mock-alpha' };
const SYSTEM = 'You are a test assistant.';

class Blocked extends Error {}

// ---------- Fake OpenAI-compatible provider (HTTP), scripted per request ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chunk = (delta, finish = null, extra = {}) => ({
  id: 'chatcmpl-bench',
  object: 'chat.completion.chunk',
  created: 1,
  model: MODEL.model,
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});
const usageChunk = () => chunk({}, 'stop', { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
const textActions = (text) => [
  { data: chunk({ role: 'assistant', content: text }) },
  { data: usageChunk() },
  { done: true },
];
const okScript = (text) => () => ({ actions: textActions(text) });

async function respond(res, step) {
  res.on('error', () => {});
  if (step.status) {
    res.writeHead(step.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(step.json));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const action of step.actions) {
    if ('data' in action) res.write(`data: ${JSON.stringify(action.data)}\n\n`);
    else if ('wait' in action) await sleep(action.wait);
    else if (action.done) res.write('data: [DONE]\n\n');
    else if (action.destroy) {
      res.socket?.destroy();
      return;
    } else if (action.hold) return;
  }
  res.end();
}

async function scenario(script) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'm1-bench-')));
  const s = {
    root,
    home: path.join(root, 'home'),
    workspace: path.join(root, 'workspace'),
    convDir: path.join(root, 'conversations'),
    requests: [],
    script,
  };
  for (const dir of [s.home, s.workspace, path.join(root, 'runtime'), path.join(root, 'tmp')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  s.server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"object":"list","data":[]}');
      return;
    }
    let raw = '';
    req.on('data', (part) => (raw += part));
    req.on('end', () => {
      s.requests.push(JSON.parse(raw));
      void respond(res, s.script(s.requests.length, s.requests.at(-1)));
    });
  });
  await new Promise((resolve) => s.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${s.server.address().port}/v1`;
  const stateDir = path.join(s.home, '.local', 'state', 'term2-nodejs');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'settings.json'),
    JSON.stringify({
      agent: { retryAttempts: 0, modelSelection: { model: MODEL.model, provider: MODEL.provider } },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
      sandbox: { enabled: false },
    }),
  );
  s.close = async () => {
    s.server.closeAllConnections();
    await new Promise((resolve) => s.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  };
  return s;
}

function cliEnv(s) {
  return {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    TERM: 'dumb',
    NO_COLOR: '1',
    HOME: s.home,
    XDG_CONFIG_HOME: path.join(s.home, '.config'),
    XDG_STATE_HOME: path.join(s.home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(s.home, '.cache'),
    XDG_DATA_HOME: path.join(s.home, '.local', 'share'),
    XDG_RUNTIME_DIR: path.join(s.root, 'runtime'),
    TMPDIR: path.join(s.root, 'tmp'),
    TERM2_CONFIG_DIR: path.join(s.home, '.term2'),
    TERM2_CACHE_DIR: path.join(s.home, '.cache', 'term2'),
    TERM2_CONVERSATIONS_DIR: s.convDir,
    DISABLE_LOGGING: '1',
  };
}

function startCli(s, args, opts = {}) {
  const child = spawn(process.execPath, [...(opts.execArgv ?? []), CLI, ...args], {
    env: { ...cliEnv(s), ...(opts.env ?? {}) },
    cwd: opts.cwd ?? s.workspace,
    stdio: [opts.stdin ?? 'ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (part) => (stdout += part));
  child.stderr.on('data', (part) => (stderr += part));
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, exited, out: () => stdout, err: () => stderr };
}

async function runCli(s, args, opts) {
  const result = await startCli(s, args, opts).exited;
  if (result.stderr.includes(STUB)) throw new Blocked(`CLI is still the M1 stub (${STUB})`);
  return result;
}

// ---------- Helpers ----------

const userItem = (id, text) => ({ type: 'user_message', id, content: [{ type: 'text', text }] });
const textOf = (item) =>
  item.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
const rolesOf = (items) => items.map((item) => item.type);
const bodyText = (content) =>
  typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('');
const lastUserText = (body) => bodyText(body.messages.filter((message) => message.role === 'user').at(-1).content);
const convFiles = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => /^conv_.+\.jsonl$/.test(name))
        .map((name) => path.join(dir, name))
    : [];
function onlyFile(dir) {
  const files = convFiles(dir);
  assert.equal(files.length, 1, `expected one conv_ log in ${dir}, found ${files.length}`);
  return files[0];
}
function snapshot(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => [
      name,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(dir, name)))
        .digest('hex'),
    ]);
}
// Every line is one fact; the file ends with a newline and seq is contiguous.
function checkFormat(file) {
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.endsWith('\n'), true, 'log must end with a newline');
  const lines = text
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line));
  lines.forEach((line, i) => {
    assert.equal(line.v, 1, 'format version');
    assert.equal(typeof line.at, 'string', 'timestamp');
    if (i > 0) assert.equal(line.seq, lines[i - 1].seq + 1, 'seq contiguous');
  });
  return lines;
}
// Deterministic in-process model: records every ModelRequest it receives.
function fakeRegistry(stream) {
  const reg = {
    resolves: 0,
    requests: [],
    resolve(ref) {
      reg.resolves += 1;
      return {
        ref,
        contextWindow: 128_000,
        stream: (request, signal) => {
          reg.requests.push(request);
          return stream(request, signal, reg.requests.length);
        },
      };
    },
    list: () => [],
  };
  return reg;
}
async function* answer(text) {
  yield { type: 'text_delta', delta: text };
  yield {
    type: 'item',
    item: { type: 'assistant_message', id: `bench_${crypto.randomUUID()}`, content: [{ type: 'text', text }] },
  };
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } };
  yield { type: 'done', stopReason: 'end_turn' };
}
const answerStream = (text) => () => answer(text);
async function runTurn(conv, input, extra = {}) {
  const turn = conv.run({ input, instructions: SYSTEM, model: MODEL, tools: [], ...extra });
  const events = [];
  for await (const event of turn.events) events.push(event);
  return events;
}
// Waits for CLI output. A run that exits first is BLOCKED if it is the stub, FAIL otherwise.
async function waitForOutput(run, text, label) {
  const start = Date.now();
  while (!run.out().includes(text)) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      if (run.err().includes(STUB)) throw new Blocked(`CLI is still the M1 stub (${STUB})`);
      throw new Error(`CLI exited before ${label}; stderr ${JSON.stringify(run.err())}`);
    }
    if (Date.now() - start > 15_000) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}
const deltas = (facts) =>
  facts
    .filter((fact) => fact.type === 'text_delta')
    .map((fact) => fact.delta)
    .join('');
const chunkedTool = () => ({
  actions: [
    {
      data: chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'shell', arguments: '{"command":"touch made-by-tool.txt"}' },
          },
        ],
      }),
    },
    { data: chunk({}, 'tool_calls') },
    { done: true },
  ],
});

// ---------- Rows ----------

const rows = [];
const row = (id, name, fn) => rows.push({ id, name, fn });

row(
  'R1',
  'success: exact stdout/stderr, §4 fact order, replay idle, reopen twice identical, no provider hit',
  async () => {
    const s = await scenario(okScript('Hello there.'));
    try {
      const r = await runCli(s, ['say hello']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, 'Hello there.\n');
      assert.equal(r.stderr, 'Profile: bare\n');
      const file = onlyFile(s.convDir);
      checkFormat(file);
      const facts = readFacts(file);
      const types = facts.map((fact) => fact.type);
      assert.equal(types[0], 'session_started');
      assert.equal(types[1], 'turn_started');
      assert.equal(types.at(-1), 'turn_ended');
      assert.equal(facts.at(-1).outcome, 'completed');
      assert.ok(
        types.slice(2, -1).every((type) => ['text_delta', 'item', 'usage'].includes(type)),
        `middle facts: ${types}`,
      );
      assert.equal(textOf(facts[1].input[0]), 'say hello');
      assert.equal(deltas(facts), 'Hello there.');
      const replayed = replay(facts);
      assert.equal(replayed.status, 'idle');
      assert.deepEqual(rolesOf(replayed.history), ['user_message', 'assistant_message']);
      assert.equal(textOf(replayed.history[1]), 'Hello there.');
      // Reopen twice: a pure read with identical bytes and no provider call.
      const before = fs.readFileSync(file);
      const reg = fakeRegistry(answerStream('must not run'));
      for (let i = 0; i < 2; i++) openConversation({ log: openLog(file), models: reg, facts: readFacts(file) }).close();
      assert.deepEqual(fs.readFileSync(file), before);
      assert.equal(reg.resolves, 0);
      assert.equal(reg.requests.length, 0);
      assert.equal(s.requests.length, 1, 'only the CLI run reached the HTTP provider');
    } finally {
      await s.close();
    }
  },
);

row('R2', 'follow-up after success (Pair): prior user is raw, notice only on the live request', async () => {
  const s = await scenario(okScript('Hello there.'));
  try {
    const r = await runCli(s, ['--profile', 'pair', 'say hello']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'Hello there.\n');
    assert.equal(r.stderr, 'Profile: pair\n');
    const wire = lastUserText(s.requests[0]);
    assert.ok(wire.endsWith('say hello') && wire !== 'say hello', 'first request carries the notice');
    assert.match(wire, /Pair Mode is ON/);
    const notice = wire.slice(0, wire.length - 'say hello'.length);
    const file = onlyFile(s.convDir);
    const facts = readFacts(file);
    assert.equal(textOf(facts.find((fact) => fact.type === 'turn_started').input[0]), 'say hello');
    const reg = fakeRegistry(answerStream('Second answer.'));
    const conv = openConversation({ log: openLog(file), models: reg, facts });
    await runTurn(conv, [userItem('bench_2', 'say again')], { notice });
    conv.close();
    assert.equal(reg.requests.length, 1);
    const input = reg.requests[0].input;
    assert.deepEqual(rolesOf(input), ['user_message', 'assistant_message', 'user_message']);
    assert.equal(textOf(input[0]), 'say hello', 'prior user message has no notice');
    assert.equal(textOf(input[1]), 'Hello there.');
    assert.equal(textOf(input[2]), `${notice}say again`, 'the new live message carries the notice');
    assert.equal(s.requests.length, 1);
  } finally {
    await s.close();
  }
});

row('R3', 'HTTP 500: exact stderr, failed terminal, follow-up request is user, user', async () => {
  const s = await scenario(() => ({ status: 500, json: { error: { message: 'boom', type: 'server_error' } } }));
  try {
    const r = await runCli(s, ['say hello']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'Profile: bare\nerror 500 boom\n');
    assert.equal(s.requests.length, 1);
    const file = onlyFile(s.convDir);
    checkFormat(file);
    const facts = readFacts(file);
    const end = facts.at(-1);
    assert.equal(end.type, 'turn_ended');
    assert.equal(end.outcome, 'failed');
    assert.equal(end.error?.message, '500 boom');
    assert.equal(replay(facts).status, 'idle');
    const reg = fakeRegistry(answerStream('Follow answer.'));
    const conv = openConversation({ log: openLog(file), models: reg, facts });
    await runTurn(conv, [userItem('bench_f', 'follow up')]);
    conv.close();
    assert.deepEqual(rolesOf(reg.requests[0].input), ['user_message', 'user_message']);
    assert.equal(textOf(reg.requests[0].input[0]), 'say hello');
    assert.equal(textOf(reg.requests[0].input[1]), 'follow up');
  } finally {
    await s.close();
  }
});

row('R4', 'truncated stream: stdout exactly "partial", one error line, follow-up carries partial', async () => {
  const s = await scenario(() => ({
    actions: [{ data: chunk({ role: 'assistant', content: 'partial' }) }, { wait: 100 }, { destroy: true }],
  }));
  try {
    const r = await runCli(s, ['say hello']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, 'partial');
    const lines = r.stderr.split('\n').filter(Boolean);
    assert.equal(lines[0], 'Profile: bare');
    assert.equal(lines.length, 2, `stderr: ${JSON.stringify(r.stderr)}`);
    assert.ok(lines[1].startsWith('error '), lines[1]);
    const file = onlyFile(s.convDir);
    checkFormat(file);
    const facts = readFacts(file);
    assert.equal(facts.at(-1).outcome, 'failed');
    const reg = fakeRegistry(answerStream('Follow answer.'));
    const conv = openConversation({ log: openLog(file), models: reg, facts });
    await runTurn(conv, [userItem('bench_f', 'follow up')]);
    conv.close();
    const input = reg.requests[0].input;
    assert.deepEqual(rolesOf(input), ['user_message', 'assistant_message', 'user_message']);
    assert.equal(textOf(input[1]), 'partial');
  } finally {
    await s.close();
  }
});

const twoFrames = () => ({
  actions: [
    { data: chunk({ role: 'assistant', content: 'alpha ' }) },
    { wait: 150 },
    { data: chunk({ content: 'beta' }) },
    { hold: true },
  ],
});
row(
  'R5',
  'SIGINT and SIGTERM after two frames: 130/143, one cancelled terminal, log holds shown bytes, follow-up carries them',
  async () => {
    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ]) {
      const s = await scenario(twoFrames);
      try {
        const run = startCli(s, ['say hello']);
        try {
          await waitForOutput(run, 'alpha beta', `${signal}: both frames shown`);
        } catch (error) {
          run.child.kill('SIGKILL');
          throw error;
        }
        run.child.kill(signal);
        const r = await run.exited;
        assert.equal(r.code, code, `${signal} exit (stderr ${JSON.stringify(r.stderr)})`);
        const file = onlyFile(s.convDir);
        checkFormat(file);
        const facts = readFacts(file);
        const ends = facts.filter((fact) => fact.type === 'turn_ended');
        assert.equal(ends.length, 1, `${signal}: exactly one turn_ended`);
        assert.equal(ends[0].outcome, 'cancelled');
        const logged = deltas(facts);
        assert.ok(logged.includes(r.stdout), `${signal}: log holds every byte stdout showed`);
        assert.ok(r.stdout.startsWith('alpha beta'));
        const reg = fakeRegistry(answerStream('After signal.'));
        const conv = openConversation({ log: openLog(file), models: reg, facts });
        await runTurn(conv, [userItem('bench_s', 'follow up')]);
        conv.close();
        assert.equal(textOf(reg.requests[0].input[1]), logged, `${signal}: follow-up carries the partial text`);
      } finally {
        await s.close();
      }
    }
  },
);

row(
  'R6',
  'SIGKILL after first frame: interrupted replay, partial carried, next turn writes one interrupted terminal',
  async () => {
    const s = await scenario(() => ({
      actions: [{ data: chunk({ role: 'assistant', content: 'alpha ' }) }, { hold: true }],
    }));
    try {
      const run = startCli(s, ['say hello']);
      try {
        await waitForOutput(run, 'alpha', 'first frame shown');
      } catch (error) {
        run.child.kill('SIGKILL');
        throw error;
      }
      run.child.kill('SIGKILL');
      const r = await run.exited;
      assert.equal(r.signal, 'SIGKILL');
      const file = onlyFile(s.convDir);
      const facts = readFacts(file);
      assert.equal(
        facts.some((fact) => fact.type === 'turn_ended'),
        false,
        'the killed turn has no terminal',
      );
      const killedTurn = facts.find((fact) => fact.type === 'turn_started').turnId;
      const before = replay(facts);
      assert.equal(before.status, 'interrupted');
      assert.equal(textOf(before.history[0]), 'say hello');
      assert.equal(textOf(before.history[1]), 'alpha ');
      const reg = fakeRegistry(answerStream('After kill.'));
      const conv = openConversation({ log: openLog(file), models: reg, facts });
      await runTurn(conv, [userItem('bench_k', 'follow up')]);
      conv.close();
      const input = reg.requests[0].input;
      assert.deepEqual(rolesOf(input), ['user_message', 'assistant_message', 'user_message']);
      assert.equal(textOf(input[1]), 'alpha ');
      const after = readFacts(file);
      const interrupted = after
        .map((fact, index) => ({ fact, index }))
        .filter(({ fact }) => fact.type === 'turn_ended' && fact.outcome === 'interrupted');
      assert.equal(interrupted.length, 1, 'exactly one interrupted terminal');
      assert.equal(interrupted[0].fact.turnId, killedTurn);
      const nextStart = after.findIndex((fact, index) => index > interrupted[0].index && fact.type === 'turn_started');
      assert.equal(nextStart, interrupted[0].index + 1, 'written in the same write as the next turn_started');
    } finally {
      await s.close();
    }
  },
);

row('R7', 'torn final line: reads ignore it, next append truncates it, interior corruption throws', async () => {
  const s = await scenario(okScript('Hello there.'));
  try {
    const r = await runCli(s, ['say hello']);
    assert.equal(r.code, 0, r.stderr);
    const file = onlyFile(s.convDir);
    const clean = fs.readFileSync(file);
    const facts = readFacts(file);
    const torn = Buffer.from('{"v":1,"seq":99,"at":"2026-10');
    fs.writeFileSync(file, Buffer.concat([clean, torn]));
    const withTorn = fs.readFileSync(file);
    assert.equal(readFacts(file).length, facts.length, 'reads tolerate an unterminated final line');
    assert.deepEqual(fs.readFileSync(file), withTorn, 'a read writes nothing');
    const log = openLog(file);
    log.append([
      { type: 'usage', turnId: facts[1].turnId, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } },
    ]);
    log.close();
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after.includes('2026-10'), false, 'torn bytes removed by the next append');
    assert.ok(after.startsWith(clean.toString('utf8')), 'earlier lines intact');
    checkFormat(file);
    assert.equal(readFacts(file).length, facts.length + 1);
    // Interior corruption must throw: a bad line, an unknown fact type, and a seq gap.
    const lines = clean.toString('utf8').slice(0, -1).split('\n');
    const mutated = {
      'bad interior line': [lines[0], 'not json', ...lines.slice(1)],
      'unknown fact type': [
        lines[0],
        ...lines.slice(1, 2).map((line) => JSON.stringify({ ...JSON.parse(line), fact: { type: 'mystery' } })),
        ...lines.slice(2),
      ],
      'seq gap': [lines[0], ...lines.slice(2)],
    };
    for (const [label, variant] of Object.entries(mutated)) {
      const variantFile = path.join(s.root, `variant-${label.replace(/\W+/g, '-')}.jsonl`);
      fs.writeFileSync(variantFile, variant.join('\n') + '\n');
      assert.throws(() => readFacts(variantFile), undefined, `${label} must throw`);
    }
  } finally {
    await s.close();
  }
});

row(
  'R8',
  'failing log (in-process): no call when early, no output or append after failure, cancel-terminal failure is failed',
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-bench-log-'));
    const meta = (id) => ({
      id,
      workspace: '/bench',
      model: MODEL,
      profile: { id: 'builtin:bare', version: 'bench', digest: 'bench' },
      appVersion: 'bench',
    });
    const failingLog = (real, shouldFail) => {
      const state = { attempts: 0, failedAt: null };
      const log = {
        path: real.path,
        append(facts) {
          state.attempts += 1;
          if (facts.some(shouldFail)) {
            state.failedAt = state.attempts;
            throw new Error('disk full (bench)');
          }
          real.append(facts);
        },
        close: () => real.close(),
      };
      return { log, state };
    };
    try {
      // 8a: session_started cannot be written, so createConversation throws before any provider call.
      const idA = `conv_${crypto.randomUUID()}`;
      const a = failingLog(createLog(dir, idA), (fact) => fact.type === 'session_started');
      const regA = fakeRegistry(answerStream('x'));
      assert.throws(() => createConversation({ log: a.log, models: regA, meta: meta(idA) }), /disk full/);
      assert.equal(regA.resolves, 0);
      assert.equal(regA.requests.length, 0);

      // 8b: turn_started cannot be written, so no provider call and a failed terminal.
      const idB = `conv_${crypto.randomUUID()}`;
      const b = failingLog(createLog(dir, idB), (fact) => fact.type === 'turn_started');
      const regB = fakeRegistry(answerStream('x'));
      const convB = createConversation({ log: b.log, models: regB, meta: meta(idB) });
      const eventsB = await runTurn(convB, [userItem('b', 'say hello')]);
      convB.close();
      assert.deepEqual(
        eventsB.map((event) => event.type),
        ['turn_ended'],
      );
      assert.equal(eventsB[0].result.kind, 'failed');
      assert.equal(regB.requests.length, 0);
      assert.equal(b.state.attempts, b.state.failedAt, 'no append after the failed one');

      // 8c: a mid-stream text_delta append fails: no further output, no further append, failed result.
      const idC = `conv_${crypto.randomUUID()}`;
      let textDeltas = 0;
      const c = failingLog(createLog(dir, idC), (fact) => fact.type === 'text_delta' && ++textDeltas === 2);
      const seenC = { aborted: false };
      const regC = fakeRegistry(async function* (request, signal) {
        for (const delta of ['a', 'b', 'c']) {
          if (signal.aborted) {
            seenC.aborted = true;
            throw { kind: 'cancelled', message: 'aborted', retryable: false };
          }
          yield { type: 'text_delta', delta };
          await sleep(30);
        }
        yield { type: 'done', stopReason: 'end_turn' };
      });
      const convC = createConversation({ log: c.log, models: regC, meta: meta(idC) });
      const eventsC = await runTurn(convC, [userItem('c', 'say hello')]);
      convC.close();
      assert.deepEqual(
        eventsC.filter((event) => event.type === 'text_delta').map((event) => event.delta),
        ['a'],
      );
      assert.equal(eventsC.at(-1).result.kind, 'failed');
      assert.notEqual(c.state.failedAt, null);
      assert.equal(c.state.attempts, c.state.failedAt, 'no append after the failed one');
      assert.equal(seenC.aborted, true, 'the provider was cancelled after the failure');

      // 8d: the cancel terminal cannot be written, so the result is failed, not cancelled.
      const idD = `conv_${crypto.randomUUID()}`;
      const d = failingLog(createLog(dir, idD), (fact) => fact.type === 'turn_ended' && fact.outcome === 'cancelled');
      const regD = fakeRegistry(async function* (request, signal) {
        for (const delta of ['a', 'b', 'c']) {
          if (signal.aborted) throw { kind: 'cancelled', message: 'aborted', retryable: false };
          yield { type: 'text_delta', delta };
          await sleep(30);
        }
      });
      const convD = createConversation({ log: d.log, models: regD, meta: meta(idD) });
      const turnD = convD.run({ input: [userItem('d', 'say hello')], instructions: SYSTEM, model: MODEL, tools: [] });
      const eventsD = [];
      for await (const event of turnD.events) {
        eventsD.push(event);
        if (event.type === 'text_delta') turnD.cancel();
      }
      convD.close();
      assert.equal(eventsD.at(-1).result.kind, 'failed', 'a failed cancel terminal is failed');
      assert.equal(
        readFacts(d.log.path).some((fact) => fact.type === 'turn_ended'),
        false,
        'no terminal was logged',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

row('R9', 'model tool call: exit 1, message names the tool, no tool_call fact, no tool effect', async () => {
  const s = await scenario(chunkedTool);
  try {
    const r = await runCli(s, ['say hello']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes('model called shell; tools are not available yet'), r.stderr);
    assert.equal(fs.existsSync(path.join(s.workspace, 'made-by-tool.txt')), false, 'no tool effect');
    const facts = readFacts(onlyFile(s.convDir));
    assert.equal(
      facts.some((fact) => fact.type === 'item' && fact.item.type === 'tool_call'),
      false,
      'no tool_call fact',
    );
    assert.equal(facts.at(-1).outcome, 'failed');
    assert.ok(facts.at(-1).error?.message.includes('shell'), 'terminal names the tool');
  } finally {
    await s.close();
  }
});

row(
  'R10',
  'directory fixtures: old entries refused with listing and bytes unchanged; empty and conv_-only run; unknown flag refused',
  async () => {
    const uuid = () => crypto.randomUUID();
    const fixtures = {
      'an old <uuid>.jsonl': { [`${uuid()}.jsonl`]: '{"old":true}\n' },
      'last.json only': { 'last.json': '{"id":"x"}' },
      'mixed conv_ and .lock': { [`conv_${uuid()}.jsonl`]: 'x\n', '.lock': '' },
      'other old names': {
        [`non-interactive-${uuid()}.jsonl`]: '{}\n',
        '.deltas': 'partial',
        '.migrated-from-log': '',
      },
    };
    for (const [label, files] of Object.entries(fixtures)) {
      const s = await scenario(okScript('Hello there.'));
      try {
        fs.mkdirSync(s.convDir, { recursive: true });
        for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(s.convDir, name), content);
        const before = snapshot(s.convDir);
        const r = await runCli(s, ['say hello']);
        assert.notEqual(r.code, 0, `${label}: must refuse`);
        assert.equal(r.stdout, '', `${label}: no answer`);
        assert.equal(s.requests.length, 0, `${label}: no provider call`);
        assert.deepEqual(snapshot(s.convDir), before, `${label}: listing and bytes unchanged`);
      } finally {
        await s.close();
      }
    }

    const empty = await scenario(okScript('Hello there.'));
    try {
      fs.mkdirSync(empty.convDir, { recursive: true });
      const r = await runCli(empty, ['say hello']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, 'Hello there.\n');
    } finally {
      await empty.close();
    }

    const convOnly = await scenario(okScript('Hello there.'));
    try {
      const first = await runCli(convOnly, ['say hello']);
      assert.equal(first.code, 0, first.stderr);
      const kept = snapshot(convOnly.convDir);
      const second = await runCli(convOnly, ['say again']);
      assert.equal(second.code, 0, second.stderr);
      assert.equal(convFiles(convOnly.convDir).length, 2);
      for (const [name, digest] of kept) {
        assert.equal(
          crypto
            .createHash('sha256')
            .update(fs.readFileSync(path.join(convOnly.convDir, name)))
            .digest('hex'),
          digest,
          `${name} unchanged by a later run`,
        );
      }
    } finally {
      await convOnly.close();
    }

    const unknown = await scenario(okScript('Hello there.'));
    try {
      const r = await runCli(unknown, ['--bogus', 'say hello']);
      assert.notEqual(r.code, 0);
      assert.ok(r.stderr.includes('--bogus'), `names the flag: ${r.stderr}`);
      assert.equal(unknown.requests.length, 0);
    } finally {
      await unknown.close();
    }
  },
);

row('R11', 'directness: the real executable loads none of the forbidden modules', async () => {
  const s = await scenario(okScript('Hello there.'));
  try {
    const hookDir = path.join(s.root, 'hook');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(
      path.join(hookDir, 'hook.mjs'),
      [
        "import fs from 'node:fs';",
        'export async function resolve(specifier, context, nextResolve) {',
        '  const result = await nextResolve(specifier, context);',
        '  if (process.env.M1_LOADED_LOG) fs.appendFileSync(process.env.M1_LOADED_LOG, result.url + "\\n");',
        '  return result;',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(hookDir, 'register.mjs'),
      "import { register } from 'node:module';\nregister(new URL('./hook.mjs', import.meta.url));\n",
    );
    const loadedLog = path.join(hookDir, 'loaded.txt');
    const r = await runCli(s, ['say hello'], {
      execArgv: ['--import', pathToFileURL(path.join(hookDir, 'register.mjs')).href],
      env: { M1_LOADED_LOG: loadedLog },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'Hello there.\n');
    const loaded = fs.readFileSync(loadedLog, 'utf8').split('\n').filter(Boolean);
    assert.ok(
      loaded.some((url) => url.endsWith('/rewrite/dist/rewrite/src/app/cli.js')),
      'the hook saw the entry point',
    );
    const forbidden =
      /\/(application-run-loop|agent-client|agent-configuration|conversation-service|conversation-orchestrator|conversation-persistence|conversation-replay|session-index-service|non-interactive)\.(c|m)?js$/;
    assert.deepEqual(
      loaded.filter((url) => forbidden.test(url)),
      [],
      'forbidden modules loaded',
    );
  } finally {
    await s.close();
  }
});

row('R12', 'home guard from a fake HOME: the four §5 rows', async () => {
  const s = await scenario(okScript('Hello there.'));
  try {
    const plain = await runCli(s, ['say hello'], { cwd: s.home });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(plain.stdout, 'Hello there.\n');
    const before = s.requests.length;
    const autoApprove = await runCli(s, ['--auto-approve', 'say hello'], { cwd: s.home });
    assert.equal(autoApprove.code, 1);
    assert.equal(autoApprove.stdout, '');
    assert.equal(
      autoApprove.stderr,
      'Headless startup refused from the home or root directory. Start in a project directory.\n',
    );
    assert.equal(s.requests.length, before, 'refused before any provider call');
    const lite = await runCli(s, ['--lite', '--auto-approve', 'say hello'], { cwd: s.home });
    assert.equal(lite.code, 0, lite.stderr);
    const noPrompt = await runCli(s, [], { cwd: s.home });
    assert.equal(noPrompt.code, 1);
    assert.ok(noPrompt.stderr.includes('Cancelled.'), noPrompt.stderr);
  } finally {
    await s.close();
  }
});

row('R13', 'flags: --version and --help exit 0 without a provider call; M1 flags listed in help', async () => {
  const s = await scenario(okScript('Hello there.'));
  try {
    const version = await runCli(s, ['--version']);
    assert.equal(version.code, 0);
    assert.notEqual(version.stdout.trim(), '');
    const help = await runCli(s, ['--help']);
    assert.equal(help.code, 0);
    for (const flag of ['--auto-approve', '--profile', '--lite'])
      assert.ok(help.stdout.includes(flag), `help lists ${flag}`);
    assert.equal(s.requests.length, 0);
  } finally {
    await s.close();
  }
});

row('R14', 'no prompt, non-TTY, outside home: interactive-terminal refusal', async () => {
  const s = await scenario(okScript('Hello there.'));
  try {
    const r = await runCli(s, []);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('term2 needs an interactive terminal'), r.stderr);
    assert.equal(s.requests.length, 0);
  } finally {
    await s.close();
  }
});

// ---------- Runner ----------

let pass = 0;
let fail = 0;
let blocked = 0;
for (const { id, name, fn } of rows) {
  const started = Date.now();
  try {
    await fn();
    pass += 1;
    console.log(`PASS    ${id} ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    const message = (error.message ?? String(error)).split('\n').slice(0, 8).join('\n          ');
    if (error instanceof Blocked || /not implemented yet/.test(error.message ?? '')) {
      blocked += 1;
      console.log(`BLOCKED ${id} ${name}\n          ${message}`);
    } else {
      fail += 1;
      console.log(`FAIL    ${id} ${name}\n          ${message}`);
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed, ${blocked} blocked, of ${rows.length} rows`);
process.exit(pass === rows.length ? 0 : 1);
