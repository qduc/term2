// Controlled runner boundary: verifies actual Session ownership, not sandbox enforcement.
import { ScopedSandboxRunner } from '../../source/utils/shell/sandbox/scoped-sandbox-runner.js';
let capturedScope: any;
const capturedScopes: any[] = [];
ScopedSandboxRunner.prototype.availability = async function () {
  capturedScope = (this as any).network;
  if (!capturedScopes.includes(capturedScope)) capturedScopes.push(capturedScope);
  return { type: 'available' };
};
ScopedSandboxRunner.prototype.wrap = async function (command: any) {
  return { command };
};
ScopedSandboxRunner.prototype.annotateFailure = async function (_command: any, stderr: any) {
  return stderr;
};
ScopedSandboxRunner.prototype.cleanupAfterCommand = async function () {
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
        if (!JSON.stringify(request.input).includes('warm-shell')) {
          const call = {
            type: 'tool_call',
            id: 'warm-shell',
            name: 'shell',
            arguments: JSON.stringify({ command: 'printf warm', sandbox: 'default' }),
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

const first = await store.createAdopted(workspaceConfig, modelRef);
await first.submission.submit({ requestId: 'warm-a' as any, input: { text: 'warm graph A' } });
await until(() => first.session.state().status === 'idle');
const second = await store.createAdopted(workspaceConfig, modelRef);
await second.submission.submit({ requestId: 'warm-b' as any, input: { text: 'warm graph B' } });
await until(() => second.session.state().status === 'idle');
assert.equal(capturedScopes.length, 2);
assert.equal(requests.length, 4);
const [a, b] = capturedScopes;
const an = first.submission.networkApproval!,
  bn = second.submission.networkApproval!;
const ar = a.request({ host: 'sol-dual.example', port: 443 }),
  br = b.request({ host: 'sol-dual.example', port: 443 });
await until(() => !!an.getSnapshot().active && !!bn.getSnapshot().active);
assert.equal(first.session.state().activeTurnId, null);
assert.equal(second.session.state().activeTurnId, null);
assert.notEqual(an.getSnapshot().active!.generation, bn.getSnapshot().active!.generation);
const ac = an.getSnapshot().active!,
  bc = bn.getSnapshot().active!;
await assert.rejects(an.decide({ requestId: bc.requestId, generation: bc.generation, answer: 'allow-session' }));
assert.deepEqual(await an.decide({ requestId: ac.requestId, generation: ac.generation, answer: 'allow-session' }), {
  kind: 'applied',
  allowed: true,
});
assert.equal(await ar, true);
assert.deepEqual(await bn.decide({ requestId: bc.requestId, generation: bc.generation, answer: 'deny' }), {
  kind: 'applied',
  allowed: false,
});
assert.equal(await br, false);
assert.equal(await a.request({ host: 'sol-dual.example', port: 443 }), true);
const retryB = b.request({ host: 'sol-dual.example', port: 443 });
await until(() => !!bn.getSnapshot().active);
assert.equal(an.getSnapshot().active, null);
await first.session.close();
const again = bn.getSnapshot().active!;
assert.deepEqual(await bn.decide({ requestId: again.requestId, generation: again.generation, answer: 'allow-once' }), {
  kind: 'applied',
  allowed: true,
});
assert.equal(await retryB, true);
const next = b.request({ host: 'sol-surviving.example' });
await until(() => !!bn.getSnapshot().active);
const nc = bn.getSnapshot().active!;
await bn.decide({ requestId: nc.requestId, generation: nc.generation, answer: false });
assert.equal(await next, false);
assert.equal(requests.length, 4);
await second.session.close();
await models.dispose();
fs.rmSync(root, { recursive: true, force: true });
console.log('PASS actual dual Session idle ownership/crossgraph rejection/session grant isolation/close A preserves B');
