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
const root = process.env.C1_PROOF_ROOT!;
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
fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify(checkpoint));
fs.writeFileSync(path.join(root, 'ready'), 'ready');
await new Promise(() => {});
