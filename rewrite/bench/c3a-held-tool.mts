import assert from 'node:assert/strict';
import { AgentClient } from '../../source/lib/agent-client.ts';
let runSettled = false;
const originalRun = AgentClient.prototype.runTurn;
AgentClient.prototype.runTurn = async function (...args: any[]) {
  try {
    return await originalRun.apply(this, args as any);
  } finally {
    runSettled = true;
  }
};
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
const mode = 'noncooperative';
let release: any;
const gate = new Promise<void>((r) => (release = r));
let invoked = false,
  finished = false;
const postExecutePauseCapability: any = {
  setActiveRunId() {},
  forTool(def: any) {
    if (def.name !== 'shell') return;
    return async (ctx: any) => {
      invoked = true;
      await gate;
      finished = true;
      fs.writeFileSync(path.join(workspace, 'late'), 'released');
      return ctx.result;
    };
  },
};
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
            name: 'shell',
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
    shell: { autoApproveMode: 'off' } as any,
  },
});
const readable = Object.keys(host.getAll()) as any;
const pair = source.forSessionBinding({ readable, writable: [] }, new Map([['shell.autoApproveMode', 'off']]) as any);
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
        toolOwnership: new ToolOwnershipRegistry(),
        postExecutePauseCapability,
        deps: { settings: pair.service, logger, sessionContextService: context, executionContext },
      },
    }),
    runtime: () => ({
      toolOwnership: new ToolOwnershipRegistry(),
      postExecutePauseCapability,
      deps: { logger, settingsService: pair.service, sessionContextService: context },
    }),
  }),
});
const { session, submission } = await store.createAdopted(workspaceConfig, modelRef);

const events: any[] = [];
session.subscribe(0, (e) => events.push(e));
const facts = () => events.filter((e) => e.kind === 'fact').map((e) => e.entry.fact);
async function until(f: () => any, label: string) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const v = f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error(`timeout ${label} ${JSON.stringify(events)}`);
}
try {
  await submission.submit({ requestId: 'one', input: { text: 'Run held tool' } });
  let seen = 0;
  while (!invoked) {
    const p = await until(
      () => facts().filter((f) => f.type === 'session_interaction_pending')[seen] || invoked,
      'approval or invoke',
    );
    if (invoked) break;
    seen++;
    await submission.decide({
      kind: 'choose',
      turnId: p.turnId,
      interactionId: p.interaction.interactionId,
      revision: p.interaction.revision,
      generation: p.generation,
      decisions: [
        {
          callId: p.interaction.descriptor.callId,
          choice: { answer: p.interaction.choices.find((c) => ['approve', 'allow-once'].includes(c.id)).id },
        },
      ],
    });
  }
  assert.ok(facts().some((f) => f.type === 'tool_started'));
  let cancelled = false;
  const cancellation = session.cancel().then(() => {
    cancelled = true;
  });
  let successorDone = false;
  const successor = submission.submit({ requestId: 'two', input: { text: 'Fresh successor' } }).then((x) => {
    successorDone = true;
    return x;
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(finished, false);
  assert.equal(cancelled, false);
  assert.equal(runSettled, false);
  assert.equal(successorDone, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'one physical effect');
  assert.equal(requests.length, 1);
  assert.equal(facts().some((f) => f.type === 'tool_result'), false);
  assert.equal(
    facts().some((f) => f.type === 'session_admitted' && f.clientRequestId === 'two'),
    false,
  );
  release();
  await cancellation;
  await successor;
  await until(
    () => facts().find((f) => f.type === 'session_admission_settled' && f.clientRequestId === 'two'),
    'successor settlement',
  );
  assert.equal(requests.length, 2);
  assert.equal(finished, true);
  assert.equal(fs.readFileSync(path.join(workspace, 'late'), 'utf8'), 'released');
  assert.equal(fs.readFileSync(target, 'utf8'), 'one physical effect');
  assert.equal(facts().filter((f) => f.type === 'session_turn_ended').length, 2);
  for (const [id, outcome, result] of [
    ['one', 'cancelled', 'aborted'],
    ['two', 'completed', 'accepted'],
  ]) {
    const admission = facts().find((f) => f.type === 'session_admitted' && f.clientRequestId === id);
    assert.ok(admission);
    assert.equal(
      facts().filter((f) => f.type === 'session_admission_settled' && f.clientRequestId === id && f.result === result)
        .length,
      1,
    );
    assert.equal(
      facts().filter((f) => f.type === 'session_turn_ended' && f.turnId === admission.turnId && f.outcome === outcome)
        .length,
      1,
    );
    if (id === 'one')
      assert.equal(
        events.filter((e) => e.kind === 'live' && e.turnId === admission.turnId && e.event.type === 'turn_ended')
          .length,
        0,
      );
  }
  console.log('PASS noncooperative', JSON.stringify({ facts: facts(), events, requests }));
} finally {
  release();
  await session.close();
  await models.dispose();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
