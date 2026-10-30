// Controlled runner boundary: verifies background Session ownership, not sandbox enforcement.
import { BackgroundShellRegistry } from '../../source/services/shell/background-shell-registry.js';
const bg = new BackgroundShellRegistry();
import { ScopedSandboxRunner } from '../../source/utils/shell/sandbox/scoped-sandbox-runner.js';
let capturedScope: any;
let cleanupCount = 0;
ScopedSandboxRunner.prototype.availability = async function () {
  capturedScope = (this as any).network;
  return { type: 'available' };
};
ScopedSandboxRunner.prototype.wrap = async function (command: any) {
  return { command };
};
ScopedSandboxRunner.prototype.annotateFailure = async function (_command: any, stderr: any) {
  return stderr;
};
ScopedSandboxRunner.prototype.cleanupAfterCommand = async function () {
  cleanupCount++;
  await (this as any).onExecutionEnded();
  (this as any).network.cancelAll('cancelled');
};
import assert from 'node:assert/strict';
import { LocalSessionStore } from '../src/session/local-store.js';
import { createAppAdoptedSessionHandleFactory } from '../src/app/adopted/session.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdoptedSettings } from '../src/config/adopted/settings.js';
import { createAdoptedModelRegistry } from '../src/model/adopted/index.js';
import { createProviderRegistry } from '../../source/providers/registry.js';
import { SessionContextService } from '../../source/services/session/session-context-service.js';
import { LoggingService } from '../../source/services/logging/logging-service.js';
import { ExecutionContext } from '../../source/services/execution-context.js';
import { ToolOwnershipRegistry } from '../../source/services/approval/tool-ownership-registry.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-bench-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
let requests: any[] = [];
const provider: any = {
  id: 'openai',
  label: 'Local fake',
  fetchModels: async () => [],
  capabilities: { supportsConversationChaining: false },
  createStreamedModel() {
    return {
      async *stream(request: any) {
        requests.push(request);
        if (requests.length === 1) {
          const call = {
            type: 'tool_call',
            id: 'warm-shell',
            name: 'shell',
            arguments: JSON.stringify({ command: 'sleep 30', sandbox: 'default', background: true }),
          };
          yield call;
          yield { type: 'completion', output: [call], responseId: 'warm' };
          return;
        }
        yield {
          type: 'completion',
          output: [{ type: 'message', content: [{ type: 'text', text: 'Bench complete' }] }],
          responseId: 'r2',
        };
      },
    };
  },
};
const providers = createProviderRegistry();
providers.upsertProvider(provider);
const { service: host, source } = createAdoptedSettings({
  disableLogging: true,
  disableFilePersistence: true,
  cli: {
    agent: {
      modelSelection: { provider: 'openai', model: 'fixture' },
      contextCompaction: { enabled: false },
      runBudget: { escalation: 'disabled' },
      retryAttempts: 0,
    } as any,
    memory: { enabled: false } as any,
    shell: { autoApproveMode: 'off' } as any,
  },
});
const readable = Object.keys(host.getAll()) as any;
const pair = source.forSessionBinding({ readable, writable: [] });
const logger = new LoggingService({ disableLogging: true });
const context = new SessionContextService();
const executionContext = new ExecutionContext();
executionContext.enterWorkspace(workspace);
const models = createAdoptedModelRegistry({
  settingsService: pair.service,
  loggingService: logger,
  sessionContextService: context,
  providerRegistry: providers,
  ownership: 'borrowed',
});
const workspaceConfig: any = { root: workspace, access: 'read_write', target: 'local' };
const modelRef: any = { provider: 'openai', model: 'fixture' };
let graphOwnership: ToolOwnershipRegistry;
let graphContext: SessionContextService;
const store = new LocalSessionStore({
  root: path.join(root, 'sessions'),
  logger,
  defaultWorkspace: workspaceConfig,
  defaultModel: modelRef,
  driverFactory: () => {
    throw new Error('combined handle expected');
  },
  adoptedHandleFactory: createAppAdoptedSessionHandleFactory({
    engine: () => {
      const ownership = (graphOwnership = new ToolOwnershipRegistry());
      const sessionContext = (graphContext = new SessionContextService());
      const execution = new ExecutionContext();
      execution.enterWorkspace(workspace);
      return {
        models,
        settings: pair.settings,
        clientOptions: {
          selection: { provider: 'openai', model: 'fixture' },
          toolOwnership: ownership,
          backgroundShellRegistry: bg,
          allowBackgroundShell: true,
          deps: { settings: pair.service, logger, sessionContextService: sessionContext, executionContext: execution },
        },
      };
    },
    runtime: () => ({
      toolOwnership: graphOwnership,
      deps: { logger, settingsService: pair.service, sessionContextService: graphContext },
    }),
  }),
});

const until = async (p: () => boolean) => {
  for (let i = 0; i < 1000; i++) {
    if (p()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw Error('condition timeout');
};
const { session, submission } = await store.createAdopted(workspaceConfig, modelRef);
await submission.submit({ requestId: 'warm-request' as any, input: { text: 'warm shell' } });
await until(() => !!session.state().pendingInteraction || session.state().status === 'idle');
await until(() => session.state().status === 'idle');
assert.ok(capturedScope);
assert.equal(requests.length, 2);
const network = submission.networkApproval!;

assert.equal(cleanupCount, 0);
assert.equal(session.state().activeTurnId, null);
assert.ok(JSON.stringify(session.state().providerHistory).includes('jobId'));
const pending = capturedScope.request({ host: 'sol-idle-background.example' });
await until(() => !!network.getSnapshot().active);
await session.cancel();
assert.ok(network.getSnapshot().active);
assert.equal(cleanupCount, 0);
const active = network.getSnapshot().active!;
assert.deepEqual(
  await network.decide({ requestId: active.requestId, generation: active.generation, answer: 'allow-once' }),
  { kind: 'applied', allowed: true },
);
assert.equal(await pending, true);
assert.equal(requests.length, 2);
await session.close();
await until(() => cleanupCount === 1);
await models.dispose();
fs.rmSync(root, { recursive: true, force: true });
console.log('PASS actual background shell idle network pending survives foreground cancel/answers/cleanup once');
