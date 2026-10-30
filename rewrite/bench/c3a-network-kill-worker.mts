// Controlled runner boundary; real Session and canonical log across process death.
import { CanonicalSessionLog } from '../src/session/adopted/conversation-log.js';
import { ScopedSandboxRunner } from '../../source/utils/shell/sandbox/scoped-sandbox-runner.js';
let capturedScope: any;
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
  await (this as any).onExecutionEnded();
  (this as any).network.cancelAll('cancelled');
};
import assert from 'node:assert/strict';
import { LocalSessionStore } from '../src/session/local-store.js';
import { createAppAdoptedSessionHandleFactory } from '../src/app/adopted/session.js';
import { createSessionRuntimeInternals } from '../../source/services/session/session-composition.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createAdoptedSettings } from '../src/config/adopted/settings.js';
import { createAdoptedModelRegistry } from '../src/model/adopted/index.js';
import { createAppAdoptedEngine } from '../src/app/adopted/engine.js';
import { loadCanonicalConversation } from '../src/session/adopted/conversation-log.js';
import { createProviderRegistry } from '../../source/providers/registry.js';
import { SessionContextService } from '../../source/services/session/session-context-service.js';
import { LoggingService } from '../../source/services/logging/logging-service.js';
import { ExecutionContext } from '../../source/services/execution-context.js';
import { ToolOwnershipRegistry } from '../../source/services/approval/tool-ownership-registry.js';
const root = process.env.PROBE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'c1-bench-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
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
let graphs = 0;
let graphOwnership: ToolOwnershipRegistry;
let graphContext: SessionContextService;
let failType = '';
let hit = false;
let fault = false;
const faultFs = new Proxy(fs, {
  get(target, key) {
    if (key === 'writeSync')
      return (...args: any[]) => {
        if (failType && String(args[1]).includes(failType)) hit = true;
        return (fs.writeSync as any)(...args);
      };
    if (key === 'fsyncSync')
      return (...args: any[]) => {
        if (hit) {
          fault = true;
          throw Error('sol injected network fsync');
        }
        return (fs.fsyncSync as any)(...args);
      };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const store = new LocalSessionStore({
  fileSystem: faultFs,
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
      graphs++;
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

if (process.env.WORKER_MODE === 'reopen') {
  const { session, submission } = await store.openAdopted(process.env.SESSION_ID as any);
  assert.equal(requests.length, 0);
  assert.equal(submission.networkApproval!.getSnapshot().active, null);
  const rows = fs.readFileSync(path.join(root, 'sessions', session.id + '.jsonl'), 'utf8');
  const networkFacts = CanonicalSessionLog.readOnly(path.join(root, 'sessions'), session.id)
    .map((e) => e.fact)
    .filter((f) => f.type.startsWith('session_network_')) as any[];
  assert.equal(networkFacts.length, 2);
  assert.equal(networkFacts[0].requestId, process.env.REQUEST_ID);
  assert.equal(networkFacts[0].generation, process.env.GENERATION);
  assert.deepEqual(networkFacts[1].resolution, { kind: 'recovered', reason: 'process_restarted' });
  assert.equal(networkFacts[1].requestId, process.env.REQUEST_ID);
  assert.equal(networkFacts[1].generation, process.env.GENERATION);
  const before = session.state().lastSeq;
  await assert.rejects(
    submission.networkApproval!.decide({
      requestId: process.env.REQUEST_ID!,
      generation: process.env.GENERATION!,
      answer: 'allow-session',
    }),
  );
  assert.equal(session.state().lastSeq, before);
  assert.equal(requests.length, 0);
  await session.close();
  const twice = await store.openAdopted(process.env.SESSION_ID as any);
  assert.equal(twice.session.state().lastSeq, before);
  assert.equal(twice.submission.networkApproval!.getSnapshot().active, null);
  assert.equal(requests.length, 0);
  await twice.session.close();
  await models.dispose();
  fs.writeFileSync(path.join(root, 'reopened.json'), JSON.stringify({ id: session.id, seq: before }));
  console.log('REOPEN_PASS');
} else {
  const { session, submission } = await store.createAdopted(workspaceConfig, modelRef);
  await submission.submit({ requestId: 'warm-before-kill' as any, input: { text: 'warm' } });
  await until(() => session.state().status === 'idle');
  assert.ok(capturedScope);
  assert.equal(requests.length, 2);
  const ignored = capturedScope.request({ host: 'sol-kill-pending.example', port: 443 });
  void ignored;
  await until(() => !!submission.networkApproval!.getSnapshot().active);
  const pending = submission.networkApproval!.getSnapshot().active!;
  fs.writeFileSync(
    path.join(root, 'ready.json'),
    JSON.stringify({
      id: session.id,
      root,
      requestId: pending.requestId,
      generation: pending.generation,
      seq: session.state().lastSeq,
    }),
  );
  console.log('PENDING_READY');
  setInterval(() => {}, 1000);
}
