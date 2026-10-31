// Controlled runner boundary; exercises real nested-shell lifecycle, not sandbox enforcement.
import { InvalidatableShellChildRegistry } from '../../source/utils/shell/shell-child-registry.js';
let observedChild: any;
const originalAdd = InvalidatableShellChildRegistry.prototype.add;
InvalidatableShellChildRegistry.prototype.add = function (child: any) {
  observedChild = child;
  originalAdd.call(this, child);
};
import { ScopedSandboxRunner } from '../../source/utils/shell/sandbox/scoped-sandbox-runner.js';
let capturedScope: any;
let capturedRunner: any;
let rootCalls = 0,
  childCalls = 0;
ScopedSandboxRunner.prototype.availability = async function () {
  capturedRunner = this;
  capturedScope = (this as any).network;
  return { type: 'available' };
};
ScopedSandboxRunner.prototype.wrap = async function (command: any) {
  if (process.env.PROBE_MODE === 'late') (this as any).onLost();
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
        const rootRequest = request.tools?.some((t: any) => t.name === 'run_subagent');
        if (rootRequest && ++rootCalls === 1) {
          const call = {
            type: 'tool_call',
            id: 'nested-run',
            name: 'run_subagent',
            arguments: JSON.stringify({
              execution: 'background',
              role: 'worker',
              task: 'Run the shell command and report.',
            }),
          };
          yield call;
          yield { type: 'completion', output: [call], responseId: 'root-start' };
          return;
        }
        if (!rootRequest && ++childCalls === 1) {
          const call = {
            type: 'tool_call',
            id: 'nested-shell',
            name: 'shell',
            arguments: JSON.stringify({
              command: `printf '%s' "$$" > '${workspace}/nested.pid'; exec sleep 30`,
              sandbox: 'default',
            }),
          };
          yield call;
          yield { type: 'completion', output: [call], responseId: 'child-start' };
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
    shell: { autoApproveMode: 'full' } as any,
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
  throw Error(
    'condition timeout ' +
      JSON.stringify({
        state: session.state(),
        requests: requests.map((r) => ({ tools: r.tools?.map((t: any) => t.name), input: r.input })),
      }),
  );
};

const { session, submission } = await store.createAdopted(workspaceConfig, modelRef);
await submission.submit({ requestId: 'nested-test' as any, input: { text: 'run nested shell' } });
if (process.env.PROBE_MODE === 'late') {
  await until(() => session.state().status === 'idle' && childCalls >= 1);
  assert.equal(observedChild, undefined);
  assert.equal(fs.existsSync(path.join(workspace, 'nested.pid')), false);
  await session.close();
  await models.dispose();
  console.log('PASS actual nested helper-loss-before-spawn refuses command/no child registration/no effect');
} else {
  await until(() => fs.existsSync(path.join(workspace, 'nested.pid')));
  const pid = Number(fs.readFileSync(path.join(workspace, 'nested.pid'), 'utf8'));
  assert.ok(pid > 1);
  assert.ok(capturedRunner);
  process.kill(pid, 0);
  capturedRunner.onLost();
  const dead = () => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.split(') ')[1]?.startsWith('Z');
    } catch {
      return true;
    }
  };
  await until(dead);
  await until(() => session.state().status === 'idle');
  assert.ok(rootCalls >= 1);
  assert.ok(childCalls >= 1);
  await session.close();
  await models.dispose();
  console.log('PASS actual nested source shell PID terminated by graph helper-loss callback/settled');
}
