import assert from 'node:assert/strict';
import { LocalSessionStore } from '../src/session/local-store.ts';
import { createAdoptedForeground } from '../src/session/adopted/foreground.ts';
import { createSessionRuntimeInternals } from '../../source/services/session/session-composition.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdoptedSettings } from '../src/config/adopted/settings.ts';
import { createAdoptedModelRegistry } from '../src/model/adopted/index.ts';
import { createAppAdoptedEngine } from '../src/app/adopted/engine.ts';
import { loadCanonicalConversation } from '../src/session/adopted/conversation-log.ts';
import { createProviderRegistry } from '../../source/providers/registry.ts';
import { SessionContextService } from '../../source/services/session/session-context-service.ts';
import { LoggingService } from '../../source/services/logging/logging-service.ts';
import { ExecutionContext } from '../../source/services/execution-context.ts';
import { ToolOwnershipRegistry } from '../../source/services/approval/tool-ownership-registry.ts';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-bench-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
const target = path.join(workspace, 'effect.txt');
let requests: any[] = [];
const rawArgs = JSON.stringify({ command: `printf 'one physical effect' >> '${target}'`, sandbox: 'unsandboxed' });
const provider: any = {
  id: 'openai',
  label: 'Local fake',
  fetchModels: async () => [],
  capabilities: { supportsConversationChaining: false },
  createStreamedModel() {
    return {
      async *stream(request: any) {
        requests.push(structuredClone(request));
        const data = { kind: 'done' };
        if (data.kind === 'call') {
          const call = { type: 'tool_call', id: 'call1', name: 'shell', arguments: rawArgs };
          yield call;
          yield { type: 'completion', output: [call], responseId: 'r1' };
        } else
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
let client: any;
const { engine, tools, turnPrompt } = createAppAdoptedEngine({
  bindSessionClient(value) {
    client = value;
  },
  models,
  settings: pair.settings,
  clientOptions: {
    selection: { provider: 'openai', model: 'fixture' },
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { settings: pair.service, logger, sessionContextService: context, executionContext },
  },
});
assert.ok(tools.original('shell'), 'source shell assembled');

let acceptedWritten = false;
const faultFs = new Proxy(fs, {
  get(target, key) {
    if (key === 'writeSync')
      return (...args: any[]) => {
        if (String(args[1]).includes('user_input_accepted')) acceptedWritten = true;
        return (fs.writeSync as any)(...args);
      };
    if (key === 'fsyncSync')
      return (...args: any[]) => {
        if (acceptedWritten) throw Error('injected accepted-input fsync');
        return (fs.fsyncSync as any)(...args);
      };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
let foreground: any;
let runtime: any;
const workspaceConfig: any = { root: workspace, access: 'read_write', target: 'local' };
const modelRef: any = { provider: 'openai', model: 'fixture' };
const store = new LocalSessionStore({
  fileSystem: faultFs,
  root: path.join(root, 'sessions'),
  logger,
  defaultWorkspace: workspaceConfig,
  defaultModel: modelRef,
  driverFactory: () => ({
    submit: (...args: any[]) => foreground.driver.submit(...args),
    decide: (...args: any[]) => foreground.driver.decide(...args),
    cancel: () => foreground.driver.cancel(),
    retry: () => foreground.driver.retry(),
    compact: () => foreground.driver.compact(),
    setModel: (...args: any[]) => foreground.driver.setModel(...args),
    subscribe: (...args: any[]) => foreground.driver.subscribe(...args),
  }),
  adoptedSubmissionFactory: (ctx) => {
    runtime = createSessionRuntimeInternals({
      sessionId: ctx.id,
      agentClient: client,
      toolOwnership: new ToolOwnershipRegistry(),
      deps: { logger, settingsService: pair.service, sessionContextService: context },
    });
    foreground = createAdoptedForeground({
      context: ctx,
      engine,
      runtime,
      restored: loadCanonicalConversation(ctx.id, path.join(root, 'sessions')),
      makeInput: (turnId) => ({
        turnId,
        history: [],
        newItems: [],
        instructions: turnPrompt().instructions,
        model: modelRef,
        toolNames: [],
        workspace: workspaceConfig,
        budget: { kind: 'adopted' },
      }),
    });
    return foreground.submission;
  },
});
const { session, submission } = await store.createAdopted(workspaceConfig, modelRef);
let resolveDone: () => void;
const done = new Promise<void>((resolve) => {
  resolveDone = resolve;
});
session.subscribe(0, (event) => {
  if (event.kind === 'fact' && event.entry.fact.type === 'session_admission_settled') resolveDone();
});
const result = await submission.submit({
  requestId: 'request1' as any,
  input: {
    text: 'Hello from adopted session',
    skill: { name: 'fixture-skill', description: 'd', body: 'EXACT_SKILL_BODY_SENTINEL' },
  },
});
assert.equal(result.kind, 'started');
await engine.waitForAdmission(new AbortController().signal);
assert.equal(acceptedWritten, true);
assert.equal(requests.length, 0, 'accepted fsync failure must block provider dispatch');
assert.equal(
  session.state().providerHistory.some((x: any) => JSON.stringify(x).includes('EXACT_SKILL_BODY_SENTINEL')),
  false,
  'failed snapshot must not project accepted native history',
);
try {
  await session.close();
} catch {}
await engine.dispose();
await models.dispose();

fs.rmSync(root, { recursive: true, force: true });
console.log('PASS actual Session accepted-input fsync failure blocks provider dispatch');
