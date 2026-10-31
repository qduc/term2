import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalSessionStore } from '../src/session/local-store.ts';
import { createAdoptedSettings } from '../src/config/adopted/settings.ts';
import { createAdoptedModelRegistry } from '../src/model/adopted/index.ts';
import { createAppAdoptedEngine } from '../src/app/adopted/engine.ts';
import { createProviderRegistry } from '../../source/providers/registry.ts';
import { SessionContextService } from '../../source/services/session/session-context-service.ts';
import { LoggingService } from '../../source/services/logging/logging-service.ts';
import { ExecutionContext } from '../../source/services/execution-context.ts';
import { ToolOwnershipRegistry } from '../../source/services/approval/tool-ownership-registry.ts';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-kill-'));
const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let stderr = '';
const child = spawn(process.execPath, ['--import', 'tsx', path.join(cwd, 'rewrite/bench/c1-adopted-kill-child.mts')], {
  cwd,
  env: { ...process.env, C1_PROOF_ROOT: root },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (b) => (stderr += b));
for (let n = 0; n < 400 && !fs.existsSync(path.join(root, 'ready')) && child.exitCode === null; n++) await delay(50);
if (!fs.existsSync(path.join(root, 'ready'))) {
  child.kill('SIGKILL');
  throw new Error(`child failed to park: ${stderr}`);
}
const checkpoint = JSON.parse(fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8'));
const workspace = path.join(root, 'workspace'),
  target = path.join(workspace, 'effect.txt');
assert.equal(checkpoint.modelCalls, 1);
assert.equal(fs.existsSync(target), false);
child.kill('SIGKILL');
await new Promise((resolve) => child.once('close', resolve));
const logger = new LoggingService({ disableLogging: true }),
  context = new SessionContextService(),
  executionContext = new ExecutionContext();
executionContext.enterWorkspace(workspace);
const store = new LocalSessionStore({
  root: path.join(root, 'log'),
  logger,
  defaultWorkspace: { root: workspace, access: 'read_write', target: 'local' },
  defaultModel: { provider: 'openai', model: 'fixture' },
  driverFactory: () => ({} as any),
});
const session = await store.open('bench' as any);
assert.equal(session.state().status, 'interrupted');
assert.equal(session.state().activeTurnId, null);
assert.equal(session.state().pendingInteraction, null);
const recoveredSeq = session.state().lastSeq;
await session.close();
const reopened = await store.open('bench' as any);
assert.equal(reopened.state().status, 'interrupted');
assert.equal(reopened.state().lastSeq, recoveredSeq);
assert.equal(reopened.state().pendingInteraction, null);
await reopened.close();
let providerCalls = 0;
const providers = createProviderRegistry();
providers.upsertProvider({
  id: 'openai',
  label: 'sentinel',
  fetchModels: async () => [],
  capabilities: { supportsConversationChaining: false },
  createStreamedModel() {
    providerCalls++;
    throw new Error('unexpected provider dispatch');
  },
});
const { service: host, source } = createAdoptedSettings({
  disableLogging: true,
  disableFilePersistence: true,
  cli: { agent: { modelSelection: { provider: 'openai', model: 'fixture' } } as any },
});
const pair = source.forSessionBinding({ readable: Object.keys(host.getAll()) as any, writable: [] });
const models = createAdoptedModelRegistry({
  settingsService: pair.service,
  loggingService: logger,
  sessionContextService: context,
  providerRegistry: providers,
  ownership: 'borrowed',
});
const { engine } = createAppAdoptedEngine({
  models,
  settings: pair.settings,
  clientOptions: {
    selection: { provider: 'openai', model: 'fixture' },
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { settings: pair.service, logger, sessionContextService: context, executionContext },
  },
});
const events: any[] = [];
for await (const e of engine.resume(checkpoint, new Map([['call1', { kind: 'approve' }]]) as any).events)
  events.push(e);
assert.equal(events.at(-1).outcome.kind, 'failed');
assert.match(events.at(-1).outcome.error.message, /checkpoint_unavailable/);
assert.equal(providerCalls, 0);
assert.equal(fs.existsSync(target), false);
await engine.dispose();
await models.dispose();
fs.rmSync(root, { recursive: true, force: true });
console.log('PASS actual SIGKILL, canonical recovery and no replay');
