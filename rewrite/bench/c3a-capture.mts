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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-bench-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
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
        assert.equal(data.kind, 'done');
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
const { session, submission } = await store.createAdopted(workspaceConfig, modelRef);
session.subscribe(session.state().lastSeq, (update) => {
  if (update.kind === 'fact') (update.entry as any).seq = 999999;
});
const received: any[] = [];
const suffix: any[] = [];
let nested: ReturnType<typeof session.capture> | undefined;
const first = session.capture((item) => {
  received.push(item);
  if (!nested) nested = session.capture((next) => suffix.push(next));
});
assert.equal(first.position.position, 0);
const retained = structuredClone(first.state);
const throwing = session.capture(() => {
  throw new Error('observer');
});
let stoppedCalls = 0;
const stopped = session.capture(() => {
  stoppedCalls++;
  stopped.unsubscribe();
});

let resolveDone: () => void;
const done = new Promise<void>((resolve) => {
  resolveDone = resolve;
});
session.subscribe(0, (event) => {
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
assert.equal(session.state().status, 'idle');
assert.deepEqual(first.state, retained, 'capture state stays immutable across commits');
assert.ok(received.some((x) => x.update.kind === 'fact'));
assert.ok(
  received.filter((x) => x.update.kind === 'fact').every((x) => x.update.entry.seq < 999999),
  'legacy listeners cannot mutate captured updates',
);
assert.ok(received.some((x) => x.update.kind === 'live'));
assert.equal(stoppedCalls, 1);
assert.ok(nested);
assert.ok(suffix.every((x) => x.position.position > nested!.position.position));
assert.ok(
  received.every((x, i) => x.position.generation === first.position.generation && x.position.position === i + 1),
);
assert.equal(nested!.state.lastSeq >= received[0].update.entry.seq, true);
first.unsubscribe();
throwing.unsubscribe();
stopped.unsubscribe();
nested!.unsubscribe();
assert.equal(requests.length, 1);
assert.ok(JSON.stringify(requests[0].input).includes('Hello from adopted session'));
assert.ok(JSON.stringify(requests[0].input).includes('SKILL-BODY'));
assert.ok(JSON.stringify(requests[0].input).includes('aGVsbG8='));
assert.ok(JSON.stringify(requests[0].input).includes('d29ybGQ='));
const id = session.id;
await session.close();
const reopenedHandle = await store.openAdopted(id);
const reopened = reopenedHandle.session;
const fresh = reopened.capture(() => {});
assert.notEqual(fresh.position.generation, first.position.generation);
assert.equal(fresh.position.position, 0);
fresh.unsubscribe();
assert.equal(graphs, 2);
assert.ok(JSON.stringify(reopened.state().providerHistory).includes('Hello from adopted session'));
assert.ok(JSON.stringify(reopened.state().providerHistory).includes('aGVsbG8='));
assert.ok(JSON.stringify(reopened.state().messages).includes('SKILL-BODY'));
const followupDone = new Promise<void>((resolve) => {
  reopened.subscribe(reopened.state().lastSeq, (event) => {
    if (event.kind === 'fact' && event.entry.fact.type === 'session_admission_settled') resolve();
  });
});
await reopenedHandle.submission.submit({ requestId: 'request2' as any, input: { text: 'Follow up' } });
await followupDone;
assert.equal(requests.length, 2);
assert.ok(JSON.stringify(requests[1].input).includes('Hello from adopted session'));
assert.ok(JSON.stringify(requests[1].input).includes('Bench complete'));
await reopened.close();
await models.dispose();
server.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('PASS Session capture ordered fact/live, reentrant capture, listener isolation and new generation');
