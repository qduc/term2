#!/usr/bin/env node
// Real-process C2 approval recovery proof; requires tsconfig.c2-proof.json build.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const proofCli = path.join(repo, 'rewrite/bench-dist/rewrite/bench/c2-proof-cli.js');
const storeModule = path.join(repo, 'rewrite/bench-dist/rewrite/src/session/local-store.js');
if (!fs.existsSync(proofCli) || !fs.existsSync(storeModule)) throw new Error('build the C2 proof entry first');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-c2-kill-'));
const home = path.join(root, 'home');
const workspace = path.join(root, 'workspace');
const conversations = path.join(root, 'conversations');
const barrier = path.join(root, 'pending.ready');
for (const dir of [home, workspace, path.join(root, 'runtime'), path.join(root, 'tmp')])
  fs.mkdirSync(dir, { recursive: true });
let providerCalls = 0;
const server = http.createServer((request, response) => {
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
    return;
  }
  request.resume();
  request.on('end', () => {
    providerCalls += 1;
    const toolCall = {
      index: 0,
      id: 'call_1',
      type: 'function',
      function: {
        name: 'shell',
        arguments: JSON.stringify({
          command: `printf 'hi\\n' > ${path.join(workspace, 'effect.txt')}`,
          description: 'Write the file',
          sandbox: 'unsandboxed',
        }),
      },
    };
    const frames =
      providerCalls === 1
        ? [
            { id: 'chatcmpl-1', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [toolCall] } }] },
            { id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : [
            {
              id: `chatcmpl-${providerCalls}`,
              choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`), 'data: [DONE]\n\n'].join(''));
  });
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake provider did not bind');
  const settingsDir = path.join(home, '.local/state/term2-nodejs');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: { retryAttempts: 0, modelSelection: { provider: 'mockprov', model: 'mock-alpha' } },
      providers: [
        {
          name: 'mockprov',
          type: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: 'test-key',
        },
      ],
      sandbox: { enabled: false },
    }),
  );
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_RUNTIME_DIR: path.join(root, 'runtime'),
    TMPDIR: path.join(root, 'tmp'),
    TERM2_CONFIG_DIR: path.join(home, '.term2'),
    TERM2_CACHE_DIR: path.join(home, '.cache/term2'),
    TERM2_CONVERSATIONS_DIR: conversations,
    TERM2_C2_PROOF_BARRIER_FILE: barrier,
    DISABLE_LOGGING: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  };
  const child = spawn(process.execPath, [proofCli, 'write a file'], { env, cwd: workspace, stdio: 'ignore' });
  for (let i = 0; i < 600 && !fs.existsSync(barrier); i += 1) await delay(50);
  if (!fs.existsSync(barrier)) {
    child.kill('SIGKILL');
    throw new Error('approval pending durability barrier was not reached');
  }
  if (providerCalls !== 1) throw new Error(`expected one provider call before approval; observed ${providerCalls}`);
  if (fs.existsSync(path.join(workspace, 'effect.txt'))) throw new Error('tool effect occurred before approval');
  child.kill('SIGKILL');
  if (child.exitCode === null) await new Promise((resolve) => child.once('close', resolve));

  const logId = fs
    .readdirSync(conversations)
    .find((name) => name.endsWith('.jsonl'))
    ?.slice(0, -6);
  if (!logId) throw new Error('killed process did not create its canonical log');
  const { LocalSessionStore } = await import(`file://${storeModule}`);
  const driverFactory = () => ({
    submit: async () => {
      throw new Error('recovery proof must not submit');
    },
    decide: async () => {
      throw new Error('recovered interactions must not be actionable');
    },
    cancel: async () => {},
    retry: async () => {
      throw new Error('recovery proof must not retry');
    },
    compact: async () => {},
    setModel: async () => {},
    subscribe: () => () => {},
  });
  const store = new LocalSessionStore({
    root: conversations,
    logger: { warn() {}, info() {} },
    defaultWorkspace: { root: workspace, access: 'read_write', target: 'local' },
    defaultModel: { provider: 'mockprov', model: 'mock-alpha' },
    driverFactory,
  });
  const recovered = await store.open(logId);
  const state1 = recovered.state();
  const seq1 = state1.lastSeq;
  if (state1.status !== 'interrupted' || state1.pendingInteraction !== null)
    throw new Error('recovered prompt remained actionable');
  await recovered.close();
  const reopened = await store.open(logId);
  const state2 = reopened.state();
  if (state2.lastSeq !== seq1 || state2.status !== 'interrupted' || state2.pendingInteraction !== null)
    throw new Error('reconciliation was not idempotent');
  await reopened.close();
  if (providerCalls !== 1) throw new Error('session open called the provider after restart');
  if (fs.existsSync(path.join(workspace, 'effect.txt')))
    throw new Error('session open executed the tool after restart');

  const envelopes = fs
    .readFileSync(path.join(conversations, `${logId}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const facts = envelopes.flatMap((envelope) =>
    envelope.event?.type === 'session_fact_batch'
      ? envelope.event.entries.map((entry) => entry.event)
      : [envelope.event],
  );
  const count = (type) => facts.filter((fact) => fact.type === type).length;
  if (
    count('session_interaction_pending') !== 1 ||
    count('session_interaction_recovered') !== 1 ||
    count('session_interaction_resolved') !== 1 ||
    count('session_interrupted') !== 1
  ) {
    throw new Error('pending/recovery audit facts are missing or duplicated');
  }
  if (count('tool_result') !== 0 || count('assistant_turn') !== 0)
    throw new Error('approval kill unexpectedly completed the tool turn');
  console.log(
    JSON.stringify({
      logId,
      providerCalls,
      status: state2.status,
      pendingInteraction: state2.pendingInteraction,
      lastSeq: state2.lastSeq,
      pending: count('session_interaction_pending'),
      recovered: count('session_interaction_recovered'),
      resolved: count('session_interaction_resolved'),
      interrupted: count('session_interrupted'),
      noEffect: true,
      repeatOpenIdempotent: true,
    }),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
