import assert from 'node:assert/strict';
import { LocalSessionStore } from '../src/session/local-store.ts';
import { createAdoptedForeground } from '../src/session/adopted/foreground.ts';
import { createSessionRuntimeInternals } from '../../source/services/session/session-composition.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
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
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const part of req) body += part;
  requests.push(JSON.parse(body));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ kind: requests.length === 1 ? 'call' : 'done' }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address() as any;
const rawArgs = JSON.stringify({ command: `printf 'one physical effect' >> '${target}'`, sandbox: 'unsandboxed' });
const provider: any = {
  id: 'openai',
  label: 'Local fake',
  fetchModels: async () => [],
  capabilities: { supportsConversationChaining: false },
  createStreamedModel() {
    return {
      async *stream(request: any) {
        const response = await fetch(`http://127.0.0.1:${address.port}/model`, {
          method: 'POST',
          body: JSON.stringify({ tools: request.tools, input: request.input }),
        });
        const data: any = await response.json();
        if (data.kind === 'call') {
          const call = {
            type: 'tool_call',
            id: 'call1',
            name: process.env.PROBE_MODE === 'unknown' ? 'missing_tool' : 'shell',
            arguments: rawArgs,
          };
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
    shell: { autoApproveMode: 'always' } as any,
  },
});
const readable = Object.keys(host.getAll()) as any;
const pair = source.forSessionBinding(
  { readable, writable: [] },
  new Map([['shell.autoApproveMode', 'always']]) as any,
);
assert.equal(pair.service.get('shell.autoApproveMode'), 'always');
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

let foreground: any;
let runtime: any;
const workspaceConfig: any = { root: workspace, access: 'read_write', target: 'local' };
const modelRef: any = { provider: 'openai', model: 'fixture' };
const store = new LocalSessionStore({
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
        toolNames: ['shell'],
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
let terminalDone: any;
const liveDone = new Promise<void>((r) => (terminalDone = r));
const startedEffects: boolean[] = [];
const observed: any[] = [];
session.subscribe(0, (event) => {
  observed.push(event);
  if (event.kind === 'live' && event.event.type === 'turn_ended') terminalDone();
  if (event.kind === 'fact' && event.entry.fact.type === 'tool_started') startedEffects.push(fs.existsSync(target));
  if (event.kind === 'fact' && event.entry.fact.type === 'session_admission_settled') resolveDone();
});
const result = await submission.submit({
  requestId: 'request1' as any,
  input: {
    text: 'Hello from adopted session',
    images: [
      { id: 'one', data: 'aGVsbG8=', mimeType: 'image/png', byteSize: 5, displayNumber: 1 },
      { id: 'two', data: 'd29ybGQ=', mimeType: 'image/jpeg', byteSize: 5, displayNumber: 2 },
    ],
    skill: { name: 'fixture', description: 'desc', body: 'SKILL-BODY' },
  },
});
assert.equal(result.kind, 'started');
await done;
await Promise.race([
  liveDone,
  new Promise((_, reject) => setTimeout(() => reject(Error('missing live terminal')), 5000)),
]);
const facts = observed.filter((e) => e.kind === 'fact').map((e) => e.entry.fact);
const live = observed.filter((e) => e.kind === 'live').map((e) => e.event);
assert.equal(live.filter((e) => e.type === 'turn_ended').length, 1);
assert.equal(facts.filter((f) => f.type === 'session_turn_ended').length, 1);
assert.equal(facts.filter((f) => f.type === 'session_admission_settled').length, 1);
assert.ok(
  observed.findIndex((e) => e.kind === 'fact' && e.entry.fact.type === 'session_turn_ended') <
    observed.findIndex((e) => e.kind === 'live' && e.event.type === 'turn_ended'),
);
if (process.env.PROBE_MODE === 'unknown') {
  assert.equal(requests.length, 2);
  assert.equal(fs.existsSync(target), false);
  assert.equal(facts.filter((f) => f.type === 'tool_started').length, 0);
  const input = requests[1].input;
  assert.equal(input.filter((i: any) => i.type === 'tool_call' && i.id === 'call1').length, 1);
  assert.equal(
    input.filter((i: any) => i.type === 'tool_result' && i.id === 'call1' && i.output === 'Unknown tool: missing_tool')
      .length,
    1,
  );
  assert.equal(facts.find((f) => f.type === 'session_admission_settled').result, 'accepted');
}
if (process.env.PROBE_MODE === 'tool') {
  assert.equal(requests.length, 2);
  assert.equal(fs.readFileSync(target, 'utf8'), 'one physical effect');
  assert.equal(facts.filter((f) => f.type === 'tool_started' && f.toolCallId === 'call1').length, 1);
  assert.deepEqual(startedEffects, [false]);
  const persisted = loadCanonicalConversation(session.id, path.join(root, 'sessions'));
  assert.equal(persisted.history.filter((i: any) => i.type === 'function_call' && i.callId === 'call1').length, 1);
  assert.equal(
    persisted.history.filter((i: any) => i.type === 'function_call_result' && i.callId === 'call1').length,
    1,
  );
  assert.ok(
    observed.findIndex((e) => e.kind === 'live' && e.event.type === 'item') <
      observed.findIndex((e) => e.kind === 'fact' && e.entry.fact.type === 'assistant_journal_item'),
  );
  const input = requests[1].input;
  assert.equal(input.filter((i: any) => i.type === 'tool_call' && i.id === 'call1').length, 1);
  assert.equal(input.filter((i: any) => i.type === 'tool_result' && i.id === 'call1').length, 1);
  assert.equal(facts.find((f) => f.type === 'session_admission_settled').result, 'accepted');
}
console.log(`PASS foreground ${process.env.PROBE_MODE} dispatch and durable replay`);
await session.close();
await engine.dispose();
await models.dispose();
server.close();

fs.rmSync(root, { recursive: true, force: true });
