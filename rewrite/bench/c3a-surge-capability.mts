import assert from 'node:assert/strict';
import { injectSkillIntoTurn } from '../../source/types/user-turn.ts';
import { issueInputSurgeApproval } from '../../source/services/input-surge-approval.ts';
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
  res.end(JSON.stringify({ kind: 'done' }));
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

let sourceDone: any;
const sourceSeen = new Promise<void>((r) => (sourceDone = r));
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
      onSourceEvent: (update) => {
        observed.push({ kind: 'source', ...update });
        if (update.event.type === 'error' && update.event.kind === 'input_surge_guard') sourceDone();
      },
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
const repeated: any[] = [{ type: 'message', role: 'user', content: 'prior' }];
for (let n = 0; n < 3; n++)
  for (let copy = 0; copy < 2; copy++) {
    repeated.push({ type: 'function_call', callId: `dup-${n}`, name: 'shell', arguments: '{}' });
    repeated.push({ type: 'function_call_result', callId: `dup-${n}`, name: 'shell', output: 'ok' });
  }
const rev = runtime.record.getProviderHistorySnapshot().revision;
assert.equal(runtime.record.replaceHistoryAtRevision(rev, repeated), true);
runtime.state.pendingModeNotice = 'MODE_NOTICE_SENTINEL';

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
const original: any = {
  text: 'Hello from adopted session',
  images: [
    { id: 'one', data: 'aGVsbG8=', mimeType: 'image/png', byteSize: 5, displayNumber: 1 },
    { id: 'two', data: 'd29ybGQ=', mimeType: 'image/jpeg', byteSize: 5, displayNumber: 2 },
  ],
  skill: { name: 'fixture', description: 'desc', body: 'SKILL-BODY' },
};
const mode = process.env.PROBE_MODE;
const token = mode === 'forged' ? ({} as any) : issueInputSurgeApproval(injectSkillIntoTurn(original));
const current = structuredClone(original);
if (mode === 'changed-image' || mode === 'mismatch-reuse') current.images[0].data = 'd29ybGQ=';
if (mode === 'changed-skill') current.skill.body = 'OTHER_SKILL';
const result = await submission.submit({ requestId: 'request1' as any, input: current }, { inputSurgeApproval: token });
assert.equal(result.kind, 'started');
await done;
const valid = mode === 'valid' || mode === 'reuse';
assert.equal(requests.length, valid ? 1 : 0);
const facts = observed.filter((e) => e.kind === 'fact').map((e) => e.entry.fact);
if (!valid) {
  await Promise.race([sourceSeen, new Promise((_, r) => setTimeout(() => r(Error('missing source drop')), 5000))]);
  assert.ok(facts.some((f) => f.type === 'error' && f.kind === 'input_surge_guard'));
  assert.ok(facts.some((f) => f.type === 'events_retracted'));
  const drop = observed.find(
    (e) => e.kind === 'source' && e.event.type === 'error' && e.event.kind === 'input_surge_guard',
  );
  assert.ok(drop);
  assert.deepEqual(drop.droppedInput, current);
  assert.ok(
    observed.indexOf(drop) >
      observed.findIndex((e) => e.kind === 'fact' && e.entry.fact.type === 'session_admission_settled'),
  );
  assert.equal(runtime.state.pendingModeNotice, 'MODE_NOTICE_SENTINEL');
} else {
  assert.equal(runtime.state.pendingModeNotice, null);
  const first = JSON.stringify(requests[0].input);
  assert.ok(first.includes('Hello from adopted session'));
  assert.ok(first.includes('aGVsbG8='));
  assert.ok(first.includes('SKILL-BODY'));
}
if (mode === 'reuse' || mode === 'mismatch-reuse') {
  const rev2 = runtime.record.getProviderHistorySnapshot().revision;
  assert.equal(runtime.record.replaceHistoryAtRevision(rev2, repeated), true);
  runtime.state.pendingModeNotice = 'SECOND_NOTICE';
  let secondDone: any;
  const finished = new Promise<void>((r) => (secondDone = r));
  session.subscribe(0, (e) => {
    if (
      e.kind === 'fact' &&
      e.entry.fact.type === 'session_admission_settled' &&
      e.entry.fact.clientRequestId === 'request2'
    )
      secondDone();
  });
  const second = await submission.submit(
    { requestId: 'request2' as any, input: original },
    { inputSurgeApproval: token },
  );
  assert.equal(second.kind, 'started');
  await finished;
  assert.equal(requests.length, mode === 'reuse' ? 1 : 0);
  assert.ok(
    observed.some(
      (e) => e.kind === 'fact' && e.entry.fact.type === 'error' && e.entry.fact.kind === 'input_surge_guard',
    ),
  );
  assert.equal(runtime.state.pendingModeNotice, 'SECOND_NOTICE');
}
console.log('PASS surge capability', mode);
await session.close();
await engine.dispose();
await models.dispose();
server.close();
fs.rmSync(root, { recursive: true, force: true });
