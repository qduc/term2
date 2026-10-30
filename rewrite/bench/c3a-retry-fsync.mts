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
let retryWrite = false,
  failed = false;
const retryFact = process.env.RETRY_TARGET === 'turn' ? 'user_turn_retried' : 'tool_output_rewound';
const faultFs = new Proxy(fs, {
  get(target, key) {
    if (key === 'writeSync')
      return (...args: any[]) => {
        if (String(args[1]).includes(retryFact)) retryWrite = true;
        return (fs.writeSync as any)(...args);
      };
    if (key === 'fsyncSync')
      return (...args: any[]) => {
        if (retryWrite) {
          failed = true;
          throw Error('injected retry boundary fsync');
        }
        return (fs.fsyncSync as any)(...args);
      };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const ownership = new ToolOwnershipRegistry();
const store = new LocalSessionStore({
  fileSystem: faultFs,
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
  await submission.submit({ requestId: 'request1' as any, input: { text: 'RETRY_FAILURE_ORIGINAL' } });
  await settle('request1');
  assert.equal(requests.length, 2);
  assert.equal(fs.readFileSync(target, 'utf8'), 'one physical effect');
  const targetKind = (process.env.RETRY_TARGET || 'tool') as 'turn' | 'tool';
  await assert.rejects(submission.retry(targetKind), /injected|Persistence/);
  assert.equal(failed, true);
  assert.equal(requests.length, 2);
  assert.equal(fs.readFileSync(target, 'utf8'), 'one physical effect');
  assert.equal(facts().filter((f) => f.type === retryFact).length, 0);
  assert.equal(facts().filter((f) => f.type === 'session_turn_started').length, 1);
  assert.equal(operations[targetKind], 1);
  await assert.rejects(submission.retry(targetKind), /injected|Persistence/);
  assert.equal(operations[targetKind], 1, 'poisoned retry must not mutate source twice');
  assert.equal(requests.length, 2);
  assert.equal(facts().filter((f) => f.type === 'session_admitted').length, 1);
  console.log(
    'PASS explicit retry',
    targetKind,
    'boundary fsync failure has no launch/public success and repeated poisoned command cannot rewind again',
  );
} finally {
  try {
    await session.close();
  } catch {}
  await models.dispose();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
