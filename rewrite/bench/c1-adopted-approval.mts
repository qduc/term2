import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createAdoptedSettings } from '../src/config/adopted/settings.ts';
import { createAdoptedModelRegistry } from '../src/model/adopted/index.ts';
import { createAppAdoptedEngine } from '../src/app/adopted/engine.ts';
import { CanonicalSessionLog, loadCanonicalConversation } from '../src/session/adopted/conversation-log.ts';
import { createProviderRegistry } from '../../source/providers/registry.ts';
import { SessionContextService } from '../../source/services/session/session-context-service.ts';
import { LoggingService } from '../../source/services/logging/logging-service.ts';
import { ExecutionContext } from '../../source/services/execution-context.ts';
import { ToolOwnershipRegistry } from '../../source/services/approval/tool-ownership-registry.ts';
import { ConversationRecord } from '../../source/services/conversation/conversation-record.ts';
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
  res.end(JSON.stringify(requests.length === 1 ? { kind: 'call' } : { kind: 'done' }));
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
const { engine, tools, turnPrompt } = createAppAdoptedEngine({
  models,
  settings: pair.settings,
  clientOptions: {
    selection: { provider: 'openai', model: 'fixture' },
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { settings: pair.service, logger, sessionContextService: context, executionContext },
  },
});
assert.ok(tools.original('shell'), 'source shell assembled');
const log = CanonicalSessionLog.create({
  root: path.join(root, 'log'),
  id: 'bench',
  metadata: {},
  workspace: { root: workspace, access: 'read_write', target: 'local' },
  model: { provider: 'openai', model: 'fixture' },
  logger,
});
await log.append([
  { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'Create requested file' } },
  { type: 'session_turn_started', version: 1, turnId: 'turn1', clientRequestId: null },
]);
const journal: any[] = [];
const record = new ConversationRecord({ logger });
record.setJournalSink((event) => journal.push(event));
record.beginTurn();
record.acceptInput('Create requested file');
const isCurrent = () => true;
let accepted = 0,
  dispatch = 0;
engine.registerTurnBridge('turn1' as any, { generation: 1, isCurrent }, (control) => ({
  prepare: async () => ({ input: record.getHistory(), options: { sessionId: 'bench' } }),
  beginSegment() {
    record.beginSegment();
  },
  acceptEvent(e: any) {
    if (e.type === 'item') record.acceptObservedItem(e.item);
    else if (e.type === 'text_delta') record.recordTextDelta(e.text);
    else if (e.type === 'reasoning_delta') record.recordReasoningDelta(e.text);
    else if (e.type === 'model_attempt_rollback') record.rollbackReasoning(e.reasoningCharacters);
  },
  acceptToolDispatch(id) {
    dispatch++;
    record.markDispatched(id);
  },
  beforeToolDispatch: async (id) => {
    await log.append([
      ...journal.splice(0),
      { type: 'tool_started', turnId: 'turn1', toolCallId: id, toolName: 'shell', arguments: JSON.parse(rawArgs) },
    ]);
    assert.equal(fs.existsSync(target), false);
  },
  acceptSegment(stream) {
    record.acceptSegment(stream, 'full_history', { logger, sessionId: 'bench' });
    accepted++;
  },
  getAcceptedHistory: () => record.getHistory(),
  async consume(stream) {
    for await (const _ of stream) {
    }
  },
  async interrupted(stream) {
    const interruption = stream.interruptions?.[0] as any;
    assert.ok(interruption);
    await log.append([
      ...journal.splice(0),
      {
        type: 'session_interaction_pending',
        version: 1,
        turnId: 'turn1',
        generation: '1',
        interaction: {
          version: 1,
          interactionId: 'i1',
          kind: 'tool_approval',
          variant: 'ordinary_tool',
          descriptor: { agentName: 'agent', toolName: 'shell', callId: 'call1', argumentsText: rawArgs },
          choices: [
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject' },
          ],
          revision: 1,
        },
      },
    ]);
    const decision = await control.park({
      generation: 1,
      isCurrent,
      decisionAddress: interruption,
      approvals: [{ callId: 'call1' as any, toolName: 'shell', requirement: { kind: 'ask', summary: 'Create file' } }],
      pendingCalls: [{ callId: 'call1' as any, toolName: 'shell', input: rawArgs }],
      validatePendingSnapshot(calls) {
        assert.equal(calls[0].input, rawArgs);
      },
      validate(ds) {
        assert.equal(ds.get('call1' as any)?.kind, 'approve');
      },
    });
    await log.append([
      {
        type: 'session_interaction_resolved',
        version: 1,
        turnId: 'turn1',
        interactionId: 'i1',
        revision: 1,
        generation: '1',
        outcome: 'answered',
        answer: { choiceId: 'approve' },
      },
    ]);
    assert.equal(fs.existsSync(target), false);
    assert.equal(decision.get('call1' as any)?.kind, 'approve');
    stream.state!.approve!(interruption);
    return {};
  },
  async completed() {
    await log.append([
      ...journal.splice(0),
      { type: 'session_turn_ended', version: 1, turnId: 'turn1', outcome: 'completed' },
    ]);
  },
  recover: async () => false,
}));
const input: any = {
  turnId: 'turn1',
  history: [],
  newItems: [],
  instructions: turnPrompt().instructions,
  model: { provider: 'openai', model: 'fixture' },
  toolNames: ['shell'],
  workspace: { root: workspace, access: 'read_write', target: 'local' },
  budget: { kind: 'adopted' },
};
const first: any[] = [];
for await (const e of engine.start(input).events) first.push(e);
assert.equal(first.at(-1)?.outcome.kind, 'suspended');
assert.equal(fs.existsSync(target), false);
assert.equal(requests.length, 1);
assert.deepEqual(
  requests[0].tools.map((tool: any) => tool.name),
  ['shell'],
);
const checkpoint = first.at(-1).outcome.checkpoint;
assert.equal(JSON.parse(JSON.stringify(checkpoint)).modelCalls, 1);
const invalidCases: any[] = [
  { checkpoint: { ...checkpoint, modelCalls: 99 }, decisions: new Map([['call1', { kind: 'approve' }]]) },
  { checkpoint, decisions: new Map() },
  {
    checkpoint,
    decisions: new Map([
      ['call1', { kind: 'approve' }],
      ['extra', { kind: 'approve' }],
    ]),
  },
  { checkpoint, decisions: new Map([['call1', { kind: 'approve', extra: true }]]) },
];
for (const candidate of invalidCases) {
  const events: any[] = [];
  for await (const e of engine.resume(candidate.checkpoint, candidate.decisions).events) events.push(e);
  assert.equal(events.at(-1).outcome.kind, 'failed');
  assert.equal(requests.length, 1);
  assert.equal(fs.existsSync(target), false);
}
const second: any[] = [];
for await (const e of engine.resume(
  JSON.parse(JSON.stringify(checkpoint)),
  new Map([['call1', { kind: 'approve' }]]) as any,
).events)
  second.push(e);
assert.equal(second.at(-1)?.outcome.kind, 'completed');
assert.equal(dispatch, 1);
assert.equal(requests.length, 2);
assert.equal(requests[1].input.filter((i: any) => i.type === 'tool_call' && i.id === 'call1').length, 1);
assert.equal(requests[1].input.filter((i: any) => i.type === 'tool_result' && i.id === 'call1').length, 1);
assert.equal(fs.readFileSync(target, 'utf8'), 'one physical effect');
assert.equal(log.entries().filter((e) => e.fact.type === 'tool_started').length, 1);
assert.ok(record.getHistory().some((i: any) => i.type === 'function_call_result'));
assert.ok(accepted >= 2);
await engine.dispose();
await log.dispose();
const reopened = CanonicalSessionLog.open({ root: path.join(root, 'log'), id: 'bench', logger });
const facts = reopened.entries().map((e) => e.fact);
assert.ok(facts.some((f: any) => f.type === 'user_message'));
assert.ok(facts.some((f: any) => f.type === 'assistant_journal_item' && f.item.type === 'tool_call'));
assert.ok(facts.some((f: any) => f.type === 'assistant_journal_item' && f.item.type === 'tool_result'));
await reopened.dispose();
const restored = loadCanonicalConversation('bench', path.join(root, 'log'));
assert.ok(restored.history.some((i: any) => i.type === 'function_call' && i.callId === 'call1'));
assert.ok(restored.history.some((i: any) => i.type === 'function_call_result' && i.callId === 'call1'));
assert.ok(restored.messages.some((m: any) => m.text === 'Create requested file'));
await models.dispose();
server.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('PASS real adopted approval, C2 durable decision/gate, one effect and canonical history');
