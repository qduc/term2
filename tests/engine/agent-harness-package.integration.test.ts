import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it('runs isolated concurrent turns from the packed public package in plain JavaScript', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'agent-harness-package-'));
  try {
    // Build current sources outside workspace dist: this cannot certify a stale build
    // or erase modules another integration worker is currently importing.
    const staged = path.join(scratch, 'package');
    await mkdir(staged);
    const compiler = fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript-7/package.json')));
    await run(
      process.execPath,
      [compiler, '-p', 'packages/agent-harness-core/tsconfig.json', '--outDir', path.join(staged, 'dist')],
      {
        cwd: process.cwd(),
        timeout: 30_000,
      },
    );
    await cp('packages/agent-harness-core/package.json', path.join(staged, 'package.json'));
    await cp('packages/agent-harness-core/README.md', path.join(staged, 'README.md'));
    const packed = await run('pnpm', ['--dir', staged, 'pack', '--pack-destination', scratch], {
      cwd: process.cwd(),
      env: { ...process.env, XDG_DATA_HOME: path.join(scratch, 'data') },
      timeout: 30_000,
    });
    const archive = (await readdir(scratch)).find((name) => name.endsWith('.tgz'));
    expect(archive, packed.stdout + packed.stderr).toBeDefined();
    await writeFile(path.join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(scratch, archive!)], {
      cwd: scratch,
      env: { ...process.env, npm_config_cache: path.join(scratch, 'npm-cache') },
      timeout: 30_000,
    });
    await writeFile(
      path.join(scratch, 'consumer.mjs'),
      String.raw`
import assert from 'node:assert/strict';
import { startTurn } from '@qduc/agent-harness-core';

let entered = 0;
let release;
const overlapping = new Promise((resolve) => { release = resolve; });
const observations = [];
async function runTurn(userId, temperature) {
  const app = { userId, settings: { temperature } };
  let calls = 0;
  const tool = {
    spec: { name: 'whoami', description: 'Return the current user', inputSchema: { type: 'object' } },
    parse: (raw) => raw,
    approval: () => ({ kind: 'none' }),
    async execute(input, ctx) {
      assert.equal(input.userId, userId);
      assert.equal(ctx.app, app);
      assert.equal(ctx.app.settings.temperature, temperature);
      ctx.progress(userId);
      observations.push(ctx.app.userId);
      return { output: ctx.app.userId, isError: false };
    },
  };
  const model = {
    ref: { provider: 'fake', model: 'fake' },
    contextWindow: 128000,
    async *stream(request, signal, onDispatched) {
      assert.equal(request.temperature, temperature);
      assert.deepEqual(request.affinity, { conversationKey: userId, cacheKey: userId + '-cache', routingKey: userId + '-route' });
      assert.equal(request.providerOptions.userId, userId);
      assert.equal(signal.aborted, false);
      onDispatched?.();
      if (calls++ === 0) {
        if (++entered === 2) release();
        await overlapping;
        yield { type: 'item', item: {
          type: 'tool_call', id: userId + '-call', callId: userId + '-call',
          toolName: 'whoami', input: { userId },
        } };
        yield { type: 'done', stopReason: 'tool_use' };
      } else {
        const result = request.input.find((item) => item.type === 'tool_result');
        assert.equal(result.output, userId);
        yield { type: 'item', item: {
          type: 'assistant_message', id: userId + '-answer', content: [{ type: 'text', text: userId }],
        } };
        yield { type: 'done', stopReason: 'end_turn' };
      }
    },
  };
  const handle = startTurn({
    turnId: userId, history: [], newItems: [], instructions: 'Identify the user',
    affinity: { conversationKey: userId, cacheKey: userId + '-cache', routingKey: userId + '-route' },
    model: { provider: 'fake', model: 'fake' }, tools: [tool.spec],
    temperature, limits: { maxModelCalls: 2, maxToolCalls: 1 },
  }, {
    models: { resolve: () => model, list: () => [] },
    tools: { get: (name) => name === 'whoami' ? tool : undefined, available: () => [tool] },
    toolContext: app,
    prepareRequest: (request) => ({ request: { ...request, providerOptions: { userId } } }),
  });
  let outcome;
  for await (const { event, token } of handle.events) {
    if (event.type === 'turn_ended') outcome = event.result;
    handle.accept(token);
  }
  assert.equal(outcome.kind, 'completed');
  assert.equal(calls, 2);
}
await Promise.all([runTurn('alice', 0.1), runTurn('bob', 0.9)]);
assert.deepEqual(observations.sort(), ['alice', 'bob']);
console.log(JSON.stringify({ concurrentUsers: observations, completed: 2 }));
`,
    );
    const result = await run(process.execPath, ['consumer.mjs'], { cwd: scratch, timeout: 20_000 });
    expect(JSON.parse(result.stdout)).toEqual({ concurrentUsers: ['alice', 'bob'], completed: 2 });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 90_000);
