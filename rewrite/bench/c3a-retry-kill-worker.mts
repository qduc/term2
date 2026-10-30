import assert from 'node:assert/strict';
import { LocalSessionStore } from '../src/session/local-store.ts';
import { createAppAdoptedSessionHandleFactory } from '../src/app/adopted/session.ts';
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
const root = process.env.PROBE_ROOT!;
const targetKind = process.env.RETRY_TARGET!;
const targetFile = path.join(root, 'workspace', 'effect.txt');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
let requests: any[] = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const part of req) body += part;
  requests.push(JSON.parse(body));
  fs.appendFileSync(path.join(root, 'requests.jsonl'), body + '\n');
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      kind: targetKind === 'tool' && requests.length === 1 && !process.env.REOPEN_ID ? 'call' : 'done',
    }),
  );
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address() as any;
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
            id: 'effect-call',
            name: 'shell',
            arguments: JSON.stringify({ command: `printf one >> '${targetFile}'`, sandbox: 'unsandboxed' }),
          };
          yield call;
          yield { type: 'completion', output: [call], responseId: 'r-call' };
          return;
        }
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
let graphs = 0;
let graphOwnership: ToolOwnershipRegistry;
let graphContext: SessionContextService;
const store = new LocalSessionStore({
  root: path.join(root, 'sessions'),
  logger,
  defaultWorkspace: workspaceConfig,
  defaultModel: modelRef,
  driverFactory: () => {
    throw new Error('combined handle expected');
  },
  adoptedHandleFactory: createAppAdoptedSessionHandleFactory({
    engine: () => {
      const ownership = (graphOwnership = new ToolOwnershipRegistry());
      const sessionContext = (graphContext = new SessionContextService());
      const execution = new ExecutionContext();
      execution.enterWorkspace(workspace);
      graphs++;
      return {
        models,
        settings: pair.settings,
        clientOptions: {
          selection: { provider: 'openai', model: 'fixture' },
          toolOwnership: ownership,
          deps: { settings: pair.service, logger, sessionContextService: sessionContext, executionContext: execution },
        },
      };
    },
    runtime: () => ({
      toolOwnership: graphOwnership,
      deps: { logger, settingsService: pair.service, sessionContextService: graphContext },
    }),
  }),
});

const observedCount = () =>
  fs.existsSync(path.join(root, 'requests.jsonl'))
    ? fs.readFileSync(path.join(root, 'requests.jsonl'), 'utf8').trim().split('\n').length
    : 0;
if (process.env.REOPEN_ID) {
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'boundary.json'), 'utf8'));
  const before = observedCount();
  const opened = await store.openAdopted(process.env.REOPEN_ID as any);
  const state = opened.session.state();
  assert.equal(graphs, 1);
  assert.equal(state.activeTurnId, null);
  assert.equal(state.pendingInteraction, null);
  assert.deepEqual(state.providerHistory, expected.history);
  assert.equal(state.messages.filter((x: any) => x.sender === 'user').length, 1);
  const original: any = state.messages.find((x: any) => x.sender === 'user');
  assert.deepEqual(original.submittedTurn, expected.original);
  assert.equal(state.admissions.request1.result, 'accepted');
  assert.equal(Object.keys(state.admissions).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(observedCount(), before);
  assert.equal(requests.length, 0);
  assert.equal(
    fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '',
    targetKind === 'tool' ? 'one' : '',
  );
  await opened.session.close();
  await models.dispose();
  server.close();
  console.log('REOPEN_PASS ' + targetKind);
  process.exit(0);
}
const { session, submission } = await store.createAdopted(workspaceConfig, modelRef);
const settled = new Promise<void>((resolve) =>
  session.subscribe(0, (e) => {
    if (e.kind === 'fact' && e.entry.fact.type === 'session_admission_settled') resolve();
  }),
);
await submission.submit({
  requestId: 'request1' as any,
  input: {
    text: 'original input',
    images: [{ id: 'image', data: 'aGVsbG8=', mimeType: 'image/png', byteSize: 5, displayNumber: 1 }],
    skill: { name: 'skill', description: 'description', body: 'SKILL-BODY' },
  },
});
await settled;
assert.equal(session.state().status, 'idle');
session.subscribe(session.state().lastSeq, (e) => {
  if (
    e.kind === 'fact' &&
    e.entry.fact.type === (targetKind === 'tool' ? 'tool_output_rewound' : 'user_turn_retried')
  ) {
    const state = session.state();
    fs.writeFileSync(
      path.join(root, 'boundary.json'),
      JSON.stringify({
        id: session.id,
        history: state.providerHistory,
        original: (state.messages.find((x: any) => x.sender === 'user') as any).submittedTurn,
        count: observedCount(),
      }),
    );
    process.kill(process.pid, 'SIGKILL');
  }
});
await submission.retry(targetKind as any);
throw Error('retry dispatch escaped synchronous fsynced-boundary kill');
