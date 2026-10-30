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
      context: ctx,
      engine,
      runtime,
      onSourceEvent: async () => {
        throw new Error('observer failure must not alter durable completion');
      },
      restored: loadCanonicalConversation(ctx.id, path.join(root, 'sessions')),
      makeInput: (turnId) => ({
        turnId,
        history: [],
        newItems: [],
        instructions: turnPrompt().instructions,
        model: modelRef,
        toolNames: [],
        workspace: workspaceConfig,
        budget: { kind: 'adopted' },
      }),
    });
    return foreground.submission;
  },
});
const { session, submission } = await store.createAdopted(workspaceConfig, modelRef);
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
assert.equal(requests.length, 1);
assert.ok(JSON.stringify(requests[0].input).includes('Hello from adopted session'));
assert.ok(JSON.stringify(requests[0].input).includes('SKILL-BODY'));
assert.ok(JSON.stringify(requests[0].input).includes('aGVsbG8='));
assert.ok(JSON.stringify(requests[0].input).includes('d29ybGQ='));
const id = session.id;
await session.close();
await engine.dispose();
const reopened = await store.open(id);
assert.ok(JSON.stringify(reopened.state().providerHistory).includes('Hello from adopted session'));
assert.ok(JSON.stringify(reopened.state().providerHistory).includes('aGVsbG8='));
assert.ok(JSON.stringify(reopened.state().messages).includes('SKILL-BODY'));
await reopened.close();
await models.dispose();
server.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('PASS actual Session + source graph + engine plain turn and reopen');
