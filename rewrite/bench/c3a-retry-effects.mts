import assert from 'node:assert/strict';
import { SessionLifecycle } from '../../source/services/session/session-lifecycle.ts';
const operations = { turn: 0, tool: 0 };
for (const [key, name] of [
  ['turn', 'retryLastUserTurn'],
  ['tool', 'retryLastToolOutput'],
] as const) {
  const original = (SessionLifecycle.prototype as any)[name];
  (SessionLifecycle.prototype as any)[name] = function (...args: any[]) {
    const result = original.apply(this, args);
    if (result) operations[key]++;
    return result;
  };
}
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
const mode = process.env.PROBE_MODE || 'explicit';
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
            name: mode.startsWith('ask') || mode === 'batch-stop' ? 'ask_user' : 'shell',
            arguments:
              mode === 'ask-malformed'
                ? JSON.stringify({ questions: [{ question: 'Bad', options: [{ label: 'Only' }] }] })
                : mode.startsWith('ask') || mode === 'batch-stop'
                ? JSON.stringify({
                    questions: [
                      { question: 'First?', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
                      { question: 'Second?', options: [{ label: 'Red' }, { label: 'Blue' }], is_multi_select: true },
                    ],
                  })
                : rawArgs,
          };
          yield call;
          const secondCall =
            mode === 'batch-stop'
              ? { type: 'tool_call', id: 'call2', name: 'shell', arguments: rawArgs }
              : mode.startsWith('batch')
              ? { ...call, id: 'call2' }
              : null;
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
console.log('AUTO_MODE', pair.service.get('shell.autoApproveMode'));
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
  const seq = session.state().lastSeq;
  const beforeIneligible = structuredClone(session.state());
  assert.deepEqual(await submission.retry('turn'), { kind: 'ineligible', target: 'turn' });
  assert.deepEqual(await submission.retry('tool'), { kind: 'ineligible', target: 'tool' });
  assert.equal(session.state().lastSeq, seq);
  assert.equal(requests.length, 0);
  assert.deepEqual(operations, { turn: 0, tool: 0 });
  assert.deepEqual(session.state(), beforeIneligible);
  const input: any = {
    text: 'ORIGINAL_EXPLICIT_RETRY',
    images: [{ id: 'image1', data: 'aGVsbG8=', mimeType: 'image/png', byteSize: 5, displayNumber: 1 }],
    skill: { name: 'test-skill', description: 'd', body: 'ONCE_SKILL_BODY' },
  };
  await submission.submit({ requestId: 'request1' as any, input });
  await settle('request1');
  assert.equal(requests.length, 2);
  assert.equal(fs.readFileSync(target, 'utf8'), 'one physical effect');
  const targetKind = (process.env.RETRY_TARGET || 'tool') as 'turn' | 'tool';
  const result = await submission.retry(targetKind);
  assert.equal(result.kind, 'started');
  await until(
    () => facts().some((f) => f.type === 'session_turn_ended' && f.turnId === result.turnId),
    'retry execution terminal',
  );
  assert.equal(requests.length, 3);
  assert.equal(fs.readFileSync(target, 'utf8'), 'one physical effect', 'rewind does not re-execute physical tool');
  assert.deepEqual(operations, targetKind === 'tool' ? { turn: 0, tool: 1 } : { turn: 1, tool: 0 });
  assert.equal(facts().filter((f) => f.type === 'user_message').length, 1);
  assert.equal(facts().filter((f) => f.type === 'session_admitted').length, 1);
  assert.equal(facts().filter((f) => f.type === 'session_admission_settled').length, 1);
  assert.equal(facts().filter((f) => f.type === 'session_turn_started' && f.clientRequestId === null).length, 1);
  assert.equal(facts().filter((f) => f.type === 'session_turn_ended').length, 2);
  const replay = JSON.stringify(requests[2].input);
  assert.equal((replay.match(/ORIGINAL_EXPLICIT_RETRY/g) || []).length, 1);
  assert.equal((replay.match(/ONCE_SKILL_BODY/g) || []).length, 1);
  assert.ok(replay.includes('aGVsbG8='));
  assert.equal(replay.includes('Bench complete'), false, 'discarded later assistant suffix absent');
  if (targetKind === 'tool') {
    assert.equal(requests[2].input.filter((i: any) => i.type === 'tool_call').length, 1);
    assert.equal(requests[2].input.filter((i: any) => i.type === 'tool_result').length, 1);
  }
  assert.equal((await submission.submit({ requestId: 'request1' as any, input })).kind, 'duplicate');
  assert.equal(requests.length, 3);
  assert.equal(session.state().admissions.request1.result, 'accepted');
  console.log(
    'PASS explicit retry',
    targetKind,
    'one source operation, no duplicate admission/user/input/skill, retained effect once and actual request replay',
  );
} finally {
  await session.close();
  await models.dispose();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
