import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'agent-package-smoke-'));

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', NODE_PATH: '' },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

try {
  const tarballs = [];
  for (const name of ['wire', 'core']) {
    const directory = join(root, 'packages', name);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.notEqual(manifest.version, '0.0.0', `${manifest.name} needs a release version`);
    assert.equal(manifest.license, 'MIT');
    assert.equal(manifest.publishConfig.access, 'public');
    run('pnpm', ['--filter', manifest.name, 'build']);
    const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary], directory))[0];
    const paths = new Set(packed.files.map((file) => file.path));
    for (const path of ['README.md', 'LICENSE', manifest.exports['.'].types, manifest.exports['.'].default]) {
      assert.ok(paths.has(path.replace(/^\.\//, '')), `${manifest.name} tarball is missing ${path}`);
    }
    if (name === 'core') {
      assert.ok(paths.has('dist/source/prompts/subagents/worker.md'), 'core tarball needs its prompt assets');
    }
    tarballs.push(join(temporary, packed.filename));
    console.log(`${manifest.name}@${manifest.version}: packed ${packed.files.length} files (${packed.size} bytes)`);
  }

  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', ...tarballs, '@types/node@24'],
    temporary,
  );
  await writeFile(
    join(temporary, 'consumer.mjs'),
    `
import assert from 'node:assert/strict';
import { createSessionRuntime, createProviderRegistry, createWebSearchRegistry, createSessionAccountStore } from '@qduc/agent-core';
import { AGENT_EVENT_TYPES, parseAgentEventEnvelope, AgentWireError } from '@qduc/agent-wire';
assert.equal(typeof createSessionRuntime, 'function');
const first = createProviderRegistry();
const second = createProviderRegistry();
first.upsertProvider({ id: 'isolated-provider' });
assert.equal(second.getProvider('isolated-provider'), undefined);
assert.notEqual(createWebSearchRegistry(), createWebSearchRegistry());
assert.notEqual(createSessionAccountStore(), createSessionAccountStore());
assert.ok(AGENT_EVENT_TYPES.includes('turn_completed'));
const event = { schemaVersion: 1, id: 1, sessionId: 'session-1', type: 'turn_completed', occurredAt: '2026-10-03T00:00:00Z', payload: {} };
assert.deepEqual(parseAgentEventEnvelope(event, 'session-1'), event);
assert.throws(() => parseAgentEventEnvelope(event, 'another-session'), AgentWireError);
console.log('Installed tarballs: runtime imports and isolation passed');
`,
  );
  await writeFile(
    join(temporary, 'consumer.ts'),
    `
import { createSessionRuntime, type SessionHandle, type CreateConversationSessionOptions } from '@qduc/agent-core';
import { parseAgentEventEnvelope, type AgentEventEnvelope } from '@qduc/agent-wire';
const event: AgentEventEnvelope = parseAgentEventEnvelope({});
const create: typeof createSessionRuntime = createSessionRuntime;
export type Consumer = { handle: SessionHandle; options: CreateConversationSessionOptions };
void event;
void create;
`,
  );
  console.log(run(process.execPath, ['consumer.mjs'], temporary).trim());
  run(
    join(root, 'node_modules', '.bin', 'tsc'),
    [
      '--noEmit',
      '--strict',
      '--types',
      'node',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      'consumer.ts',
    ],
    temporary,
  );
  console.log('Installed tarballs: public TypeScript declarations passed');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
