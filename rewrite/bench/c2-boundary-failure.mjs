#!/usr/bin/env node
// Real-runner proof that failures at pending/final event boundaries block publication.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const proofCli = path.join(repo, 'rewrite/bench-dist/rewrite/bench/c2-proof-cli.js');
if (!fs.existsSync(proofCli)) throw new Error('build the C2 proof entry first');
for (const failure of ['boundary-write', 'boundary-fsync']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `term2-c2-${failure}-`));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const conversations = path.join(root, 'conversations');
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
      const frames =
        failure === 'boundary-write'
          ? [
              {
                id: 'chatcmpl-1',
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_1',
                          type: 'function',
                          function: {
                            name: 'shell',
                            arguments: JSON.stringify({
                              command: `printf 'bad\n' > ${path.join(workspace, 'effect.txt')}`,
                              description: 'Write a file',
                              sandbox: 'unsandboxed',
                            }),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              { id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            ]
          : [
              {
                id: 'chatcmpl-1',
                choices: [
                  { index: 0, delta: { role: 'assistant', content: 'must not publish' }, finish_reason: 'stop' },
                ],
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
      TERM2_C2_PROOF_FAIL: failure,
      DISABLE_LOGGING: '1',
      NO_COLOR: '1',
      TERM: 'dumb',
    };
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [proofCli, failure === 'boundary-write' ? 'write a file' : 'respond with text'],
        { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    if (result.code === 0 || result.signal)
      throw new Error(`${failure} failure was reported as success or signal: ${JSON.stringify(result)}`);
    if (providerCalls !== 1) throw new Error(`${failure} should reach exactly one provider call; got ${providerCalls}`);
    if (failure === 'boundary-write' && fs.existsSync(path.join(workspace, 'effect.txt')))
      throw new Error('failed pending boundary allowed tool effect');
    const log = fs.readdirSync(conversations).find((name) => name.endsWith('.jsonl'));
    if (!log) throw new Error('missing canonical C2 log');
    const envelopes = fs
      .readFileSync(path.join(conversations, log), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const facts = envelopes.flatMap((envelope) =>
      envelope.event?.type === 'session_fact_batch'
        ? envelope.event.entries.map((entry) => entry.event)
        : [envelope.event],
    );
    if (failure === 'boundary-write' && facts.some((fact) => fact.type === 'session_interaction_pending'))
      throw new Error('failed append exposed actionable pending state');
    const terminal = facts.filter((fact) =>
      ['assistant_turn', 'session_turn_ended', 'session_admission_settled'].includes(fact.type),
    );
    if (failure === 'boundary-fsync' && terminal.length !== 0 && terminal.length !== 3)
      throw new Error('failed fsync left a partial terminal transaction');
    console.log(
      JSON.stringify({
        failure,
        exitCode: result.code,
        providerCalls,
        noToolEffect: !fs.existsSync(path.join(workspace, 'effect.txt')),
        transientTextObserved: result.stdout.includes('must not publish'),
        completeTerminalBatchPresent: terminal.length === 3,
        durableFacts: facts.map((fact) => fact.type),
      }),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
