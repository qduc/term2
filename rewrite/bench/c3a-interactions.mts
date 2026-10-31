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
import { createAppAdoptedSessionHandleFactory } from '../src/app/adopted/session.ts';
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
const mode = process.env.PROBE_MODE || 'repeat';
let requests: any[] = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const part of req) body += part;
  requests.push(JSON.parse(body));
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({ kind: requests.length <= (mode === 'repeat' ? 2 : 1) ? 'call' : 'done', index: requests.length }),
  );
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
            id: `call${data.index}`,
            name: mode.startsWith('ask') ? 'ask_user' : 'shell',
            arguments: mode.startsWith('ask')
              ? JSON.stringify({
                  questions: [
                    { question: 'First?', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
                    { question: 'Second?', options: [{ label: 'Red' }, { label: 'Blue' }], is_multi_select: true },
                  ],
                })
              : rawArgs,
          };
          yield call;
          const secondCall = mode === 'batch' ? { ...call, id: 'call2' } : null;
          if (secondCall) yield secondCall;
          yield {
            type: 'completion',
            usage: { inputTokens: 11, outputTokens: 3 },
            output: secondCall ? [call, secondCall] : [call],
            responseId: `r${data.index}`,
          };
        } else
          yield {
            type: 'completion',
            output: [{ type: 'message', content: [{ type: 'text', text: 'Bench complete' }] }],
            responseId: 'done',
            usage: { inputTokens: 17, outputTokens: 5 },
          };
      },
    };
  },
};
const providers = createProviderRegistry();
providers.upsertProvider(provider);
const { service: host, source } = createAdoptedSettings({
  settingsDir: path.join(root, 'settings'),
  disableLogging: true,
  disableFilePersistence: true,
  cli: {
    agent: {
      modelSelection: { provider: 'openai', model: 'fixture' },
      contextCompaction: { enabled: false },
      runBudget: { escalation: 'disabled' },
      retryAttempts: 0,
    } as any,
    // ask_user needs Pair's user-interaction capability; retain Bare for shell approvals.
    ...(mode.startsWith('ask') ? { app: { activeProfileId: 'builtin:pair' } } : {}),
    memory: { enabled: false } as any,
    shell: { autoApproveMode: 'off' } as any,
  },
});
const readable = Object.keys(host.getAll()) as any;
const pair = source.forSessionBinding({ readable, writable: [] }, new Map([['shell.autoApproveMode', 'off']]) as any);

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
const ownership = new ToolOwnershipRegistry();
const store = new LocalSessionStore({
  root: path.join(root, 'sessions'),
  logger,
  defaultWorkspace: workspaceConfig,
  defaultModel: modelRef,
  adoptedHandleFactory: createAppAdoptedSessionHandleFactory({
    engine: () => ({
      models,
      settings: pair.settings,
      clientOptions: {
        selection: { provider: 'openai', model: 'fixture' },
        toolOwnership: ownership,
        deps: { settings: pair.service, logger, sessionContextService: context, executionContext },
      },
    }),
    runtime: () => ({
      toolOwnership: ownership,
      deps: { logger, settingsService: pair.service, sessionContextService: context },
    }),
  }),
});
const { session, submission } = await store.createAdopted(workspaceConfig, modelRef);

const events: any[] = [];
session.subscribe(0, (e) => events.push(e));
async function until(predicate: () => any, label: string) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error(`timeout waiting ${label}: ${JSON.stringify(events)}`);
}
const facts = () => events.filter((e) => e.kind === 'fact').map((e) => e.entry.fact);
const pending = async (n: number) =>
  until(() => facts().filter((f) => f.type === 'session_interaction_pending')[n], `pending ${n}`);
const settle = async (id: string) =>
  until(
    () => facts().find((f) => f.type === 'session_admission_settled' && f.clientRequestId === id),
    `settlement ${id}`,
  );
const choose = async (f: any, answer: string, extra: any = {}) =>
  submission.decide({
    kind: 'choose',
    turnId: f.turnId,
    interactionId: f.interaction.interactionId,
    revision: f.interaction.revision,
    generation: f.generation,
    decisions: [{ callId: f.interaction.descriptor.callId, choice: { answer, ...extra } }],
  });
const nav = async (f: any, direction: string) =>
  submission.decide({
    kind: 'navigate',
    turnId: f.turnId,
    interactionId: f.interaction.interactionId,
    revision: f.interaction.revision,
    generation: f.generation,
    direction,
  });
try {
  const result = await submission.submit({ requestId: 'request1', input: { text: 'Carry out request' } });
  assert.equal(result.kind, 'started');
  const first = await pending(0);
  assert.equal(fs.existsSync(target), false);
  if (mode === 'batch') {
    await choose(first, 'approve');
    const second = await pending(1);
    assert.equal(fs.existsSync(target), false);
    await choose(second, 'approve');
    await settle('request1');
    assert.equal(fs.readFileSync(target, 'utf8'), 'one physical effectone physical effect');
    assert.equal(requests.length, 2);
    assert.equal(facts().filter((f) => f.type === 'session_interaction_resolved').length, 2);
    assert.equal(facts().filter((f) => f.type === 'command_message' && f.message.callId === 'call1').length, 1);
    assert.equal(facts().filter((f) => f.type === 'command_message' && f.message.callId === 'call2').length, 1);
  } else if (mode === 'repeat') {
    await choose(first, 'approve');
    const second = await pending(1);
    assert.equal(fs.readFileSync(target, 'utf8'), 'one physical effect');
    await choose(second, 'approve');
    await settle('request1');
    assert.equal(fs.readFileSync(target, 'utf8'), 'one physical effectone physical effect');
    assert.equal(requests.length, 3);
    assert.equal(facts().filter((f) => f.type === 'session_interaction_resolved').length, 2);
    const rows = facts().filter((f) => f.type === 'command_message');
    assert.equal(rows.filter((f) => f.message.callId === 'call1').length, 1);
    assert.equal(rows.filter((f) => f.message.callId === 'call2').length, 1);
    const turn = facts().find((f) => f.type === 'assistant_turn');
    assert.deepEqual(turn.usage, { prompt_tokens: 39, completion_tokens: 11, total_tokens: 50 });
  } else if (mode === 'reject') {
    await choose(first, 'reject', { rejectionReason: 'fixture rejection' });
    await settle('request1');
    assert.equal(fs.existsSync(target), false);
    assert.ok(JSON.stringify(requests[1]).includes('fixture rejection'));
    assert.equal(
      facts().find((f) => f.type === 'session_interaction_resolved').answer.rejectionReason,
      'fixture rejection',
    );
  } else if (mode === 'ask-nav') {
    assert.equal(first.interaction.kind, 'ask_user');
    await choose(first, 'option:0');
    const second = await pending(1);
    assert.equal(second.interaction.askUser.currentQuestionIndex, 1);
    assert.deepEqual(second.interaction.askUser.answers, ['Alpha']);
    const seq = session.state().lastSeq;
    await assert.rejects(nav(second, 'next'));
    assert.equal(session.state().lastSeq, seq);
    assert.deepEqual(session.state().pendingInteraction.interaction, second.interaction);
    await nav(second, 'previous');
    const third = await pending(2);
    assert.equal(third.interaction.askUser.currentQuestionIndex, 0);
    await nav(third, 'next');
    const fourth = await pending(3);
    assert.equal(fourth.interaction.askUser.currentQuestionIndex, 1);
    await nav(fourth, 'previous');
    const fifth = await pending(4);
    await choose(fifth, 'option:0');
    const sixth = await pending(5);
    await choose(sixth, 'custom', { approvalAnswer: JSON.stringify(['Red', 'Blue']) });
    await settle('request1');
    assert.equal(requests.length, 2);
    assert.ok(JSON.stringify(requests[1]).includes('Alpha'));
    assert.ok(JSON.stringify(requests[1]).includes('Red'));
    assert.ok(JSON.stringify(requests[1]).includes('Blue'));
    assert.equal(facts().filter((f) => f.type === 'command_message' && f.message.callId === 'call1').length, 1);
  } else if (mode === 'ask-cancel' || mode === 'ask-next' || mode === 'ask-queued') {
    const queued =
      mode === 'ask-queued' ? submission.submit({ requestId: 'request2', input: { text: 'A new task' } }) : null;
    await choose(first, 'cancel');
    await settle('request1');
    assert.equal(requests.length, 1);
    assert.equal(facts().filter((f) => f.type === 'session_interaction_resolved').length, 1);
    assert.ok(JSON.stringify(facts()).includes('User did not provide an answer.'));
    if (queued) {
      await queued;
      await settle('request2');
      assert.equal(requests.length, 2);
      assert.equal(
        JSON.stringify(requests[1]).includes('user cancelled the pending question without answering'),
        false,
      );
    }
  }
  assert.equal(facts().filter((f) => f.type === 'session_turn_ended').length, mode === 'ask-queued' ? 2 : 1);
  assert.equal(facts().filter((f) => f.type === 'session_admission_settled').length, mode === 'ask-queued' ? 2 : 1);
  if (mode === 'ask-next') {
    await submission.submit({ requestId: 'request2', input: { text: 'A new task' } });
    await settle('request2');
    assert.equal(requests.length, 2);
    assert.equal(JSON.stringify(requests[1]).includes('user cancelled the pending question without answering'), false);
  }
  console.log('PASS', mode, JSON.stringify({ requests: requests.length, facts: facts().map((f) => f.type) }));
} finally {
  await session.close();
  await models.dispose();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
