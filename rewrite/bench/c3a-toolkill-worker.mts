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
const root = process.env.PROBE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'c3a-stage2-kill-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const target = path.join(workspace, 'effect.txt');
const mode = process.env.PROBE_MODE || 'repeat';
let requests: any[] = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const part of req) body += part;
  requests.push(JSON.parse(body));
  fs.appendFileSync(path.join(root, 'provider-count'), 'x');
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      kind: process.env.REOPEN_ID ? 'done' : requests.length === 1 ? 'call' : 'done',
      index: requests.length,
    }),
  );
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address() as any;
const rawArgs = JSON.stringify({
  command: `printf 'one' >> '${target}'; echo $$ > '${root}/shell-pid'; while [ ! -f '${root}/release' ]; do sleep 0.05; done`,
  sandbox: 'unsandboxed',
});
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
        deps: { settings: pair.service, logger, sessionContextService: context, executionContext },
      },
    }),
    runtime: () => ({
      toolOwnership: new ToolOwnershipRegistry(),
      deps: { logger, settingsService: pair.service, sessionContextService: context },
    }),
  }),
});

const events: any[] = [];
async function until(f: () => any, label: string) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const v = f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('timeout ' + label);
}
if (process.env.REOPEN_ID) {
  const id = process.env.REOPEN_ID;
  let { session, submission } = await store.openAdopted(id as any);
  assert.equal(session.state().status, 'interrupted');
  assert.equal(session.state().activeTurnId, null);
  assert.equal(session.state().pendingInteraction, null);
  assert.equal(session.state().admissions.request1.result, 'aborted');
  let entries = CanonicalSessionLog.readOnly(path.join(root, 'sessions'), session.id);
  assert.equal(entries.filter((e) => e.fact.type === 'session_interrupted').length, 1);
  assert.equal(entries.filter((e) => e.fact.type === 'tool_started').length, 1);
  const seq = session.state().lastSeq;
  assert.equal(requests.length, 0);
  await session.close();
  ({ session, submission } = await store.openAdopted(id as any));
  assert.equal(session.state().lastSeq, seq);
  assert.equal(requests.length, 0);
  session.subscribe(0, (e) => events.push(e));
  await submission.submit({ requestId: 'request2', input: { text: 'Fresh follow-up' } });
  await until(
    () =>
      events.find(
        (e) =>
          e.kind === 'fact' &&
          e.entry.fact.type === 'session_admission_settled' &&
          e.entry.fact.clientRequestId === 'request2',
      ),
    'followup',
  );
  assert.equal(requests.length, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'one');
  const items = requests[0].input;
  assert.equal(items.filter((i) => i.type === 'tool_call' && i.id === 'call1').length, 1);
  const results = items.filter((i) => i.type === 'tool_result' && i.id === 'call1');
  assert.equal(results.length, 1);
  assert.ok(results[0].output.includes('Outcome unobserved'));
  assert.ok(JSON.stringify(items).includes('Fresh follow-up'));
  console.log('FOLLOWUP', JSON.stringify(items));
  await session.close();
  await models.dispose();
  server.close();
  console.log('REOPEN_PASS');
} else {
  const { session, submission } = await store.createAdopted(workspaceConfig, modelRef);
  session.subscribe(0, (e) => {
    if (e.kind === 'fact' && e.entry.fact.type === 'tool_started') console.log('STARTED ' + session.id);
  });
  await submission.submit({ requestId: 'request1', input: { text: 'Execute once' } });
}
