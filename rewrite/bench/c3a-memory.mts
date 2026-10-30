import { SessionTurnAdapter } from '../../source/services/session/session-turn-adapter.ts';
import { TurnCoordinator } from '../../source/services/session/turn-coordinator.ts';
for (const name of ['executeInitial', 'executeContinuation', 'beginAdoptedTurn', 'continuePostExecute'])
  (SessionTurnAdapter.prototype as any)[name] = () => {
    throw new Error('FORBIDDEN whole adapter ' + name);
  };
for (const name of ['start', 'continueAfterApproval', 'continueAfterPostExecuteApproval'])
  (TurnCoordinator.prototype as any)[name] = () => {
    throw new Error('FORBIDDEN coordinator ' + name);
  };
import assert from 'node:assert/strict';
import { FileMemoryStore } from '../../source/services/memory/memory-store.js';
import { AutomaticMemoryCanary } from '../../source/services/memory/automatic-memory-canary.js';
import { LocalSessionStore } from '../src/session/local-store.ts';
import { CanonicalSessionLog } from '../src/session/adopted/conversation-log.ts';
import { createAppAdoptedSessionHandleFactory } from '../src/app/adopted/session.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createAdoptedSettings } from '../src/config/adopted/settings.ts';
import { createAdoptedModelRegistry } from '../src/model/adopted/index.ts';
import { createProviderRegistry } from '../../source/providers/registry.ts';
import { SessionContextService } from '../../source/services/session/session-context-service.ts';
import { LoggingService } from '../../source/services/logging/logging-service.ts';
import { ExecutionContext } from '../../source/services/execution-context.ts';
import { ToolOwnershipRegistry } from '../../source/services/approval/tool-ownership-registry.ts';
const mode = process.env.PROBE_MODE ?? 'plain';
const memoryEvents: any[] = [];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c3a-memory-'));
const memoryStore = new FileMemoryStore({ root: path.join(root, 'memory') });
let memoryCalls = 0;
const automaticMemory = ['error', 'retry', 'approval', 'failure', 'cancel'].includes(mode)
  ? {
      async record() {
        memoryCalls++;
        if (mode === 'error') throw new Error('controlled storage error');
        return null;
      },
    }
  : new AutomaticMemoryCanary(memoryStore);
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
let requests: any[] = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const part of req) body += part;
  requests.push(JSON.parse(body));
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({ kind: (mode === 'approval' || mode === 'cancel') && requests.length === 1 ? 'call' : 'done' }),
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
        if (mode === 'failure') throw new Error('controlled provider failure');
        if (data.kind === 'call') {
          const call = {
            type: 'tool_call',
            id: 'memory-approval-call',
            name: 'shell',
            arguments: JSON.stringify({
              command: `printf 'effect' > '${path.join(workspace, 'effect.txt')}'`,
              sandbox: 'unsandboxed',
            }),
          };
          yield call;
          yield { type: 'completion', output: [call], responseId: 'approval' };
          return;
        }
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
    memory: { enabled: mode !== 'disabled' } as any,
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
    onSourceEvent: (event: any) => memoryEvents.push(event),
    runtime: () => ({
      automaticMemory,
      toolOwnership: graphOwnership,
      deps: { logger, settingsService: pair.service, sessionContextService: graphContext },
    }),
  }),
});
const { session, submission } = await store.createAdopted(workspaceConfig, modelRef);
const updates: any[] = [];
session.subscribe(0, (e) => updates.push(e));
async function settle(id: string) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (
      updates.some(
        (e) =>
          e.kind === 'fact' && e.entry.fact.type === 'session_admission_settled' && e.entry.fact.clientRequestId === id,
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('settlement timeout ' + JSON.stringify(updates));
}
try {
  for (let i = 0; i < (mode === 'approval' || mode === 'failure' || mode === 'cancel' ? 1 : 2); i++) {
    const input: any = { text: 'Remember for future sessions: I prefer concise explanations.' };
    if (mode === 'image')
      input.images = [{ id: 'one', data: 'aGVsbG8=', mimeType: 'image/png', byteSize: 5, displayNumber: 1 }];
    if (mode === 'skill') input.skill = { name: 'fixture', description: 'desc', body: 'SKILL-BODY' };
    await submission.submit({ requestId: 'memory-' + i, input });
    if (mode === 'approval' || mode === 'cancel') {
      const until = Date.now() + 10000;
      let pending: any;
      while (
        !(pending = updates.find((e) => e.kind === 'fact' && e.entry.fact.type === 'session_interaction_pending')?.entry
          .fact)
      ) {
        if (Date.now() > until) throw new Error('approval timeout');
        await new Promise((r) => setTimeout(r, 10));
      }
      if (mode === 'cancel') await session.cancel();
      else {
        await submission.decide({
          kind: 'choose',
          turnId: pending.turnId,
          interactionId: pending.interaction.interactionId,
          revision: pending.interaction.revision,
          generation: pending.generation,
          decisions: [{ callId: pending.interaction.descriptor.callId, choice: { answer: 'approve' } }],
        });
      }
    }
    await settle('memory-' + i);
  }
  if (mode === 'retry') {
    assert.equal(memoryCalls, 2, 'initial responses reach finalizer');
    const priorEnds = updates.filter((e) => e.kind === 'fact' && e.entry.fact.type === 'session_turn_ended').length;
    assert.equal((await submission.retry('turn')).kind, 'started');
    const until = Date.now() + 10000;
    while (
      updates.filter((e) => e.kind === 'fact' && e.entry.fact.type === 'session_turn_ended').length === priorEnds
    ) {
      if (Date.now() > until) throw new Error('retry settlement timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
    await session.cancel();
    assert.equal(memoryCalls, 2, 'retry does not reach finalizer even without canary deduplication');
  }
  assert.equal(
    requests.length,
    mode === 'retry' ? 3 : mode === 'failure' || mode === 'cancel' ? 1 : 2,
    'provider request count',
  );
  if (mode === 'approval') assert.equal(fs.readFileSync(path.join(workspace, 'effect.txt'), 'utf8'), 'effect');
  if (mode === 'approval' || mode === 'failure' || mode === 'cancel')
    assert.equal(memoryCalls, 0, 'no finalizer call on approval continuation, failure or cancellation');
  await session.cancel();
  const events = memoryEvents
    .map((e) => e.event)
    .filter((e) => e.type === 'command_message' && e.message.toolName === 'automatic_memory');
  const stored = await memoryStore.list();
  const expected = ['image', 'skill', 'disabled', 'error', 'retry', 'approval', 'failure', 'cancel'].includes(mode)
    ? 0
    : 1;
  assert.equal(stored.length, expected, 'real memory storage writes once');
  assert.equal(events.length, mode === 'error' ? 1 : expected, 'one receipt or storage error');
  const durable = CanonicalSessionLog.readOnly(path.join(root, 'sessions'), session.id).filter(
    (e: any) => e.fact.type === 'command_message' && e.fact.message.toolName === 'automatic_memory',
  );
  assert.equal(durable.length, events.length, 'source events committed to canonical log');
  if (mode === 'error') {
    assert.equal(memoryCalls, 1, 'graph lifetime error latch');
    assert.equal(events[0].message.status, 'failed');
    assert.equal(events[0].message.command, 'Automatic memory canary disabled');
  } else if (expected) {
    const memory = stored[0];
    assert.equal(memory.title, 'Remember for future sessions: I prefer concise explanations.');
    assert.equal(
      events[0].message.output,
      `Learned (project): ${memory.title}\nSource session: ${session.id}\nReview with memory_get({scope:"project",id:"${memory.id}"}); undo with memory_delete({scope:"project",id:"${memory.id}"})`,
    );
    assert.equal(events[0].message.status, 'completed');
  }
  if (mode === 'retry') {
    const requestCount = requests.length;
    await session.close();
    const reopened = await store.openAdopted(session.id);
    assert.equal(graphs, 2, 'cold reopen builds a fresh graph');
    assert.equal(requests.length, requestCount, 'replay never dispatches provider');
    assert.equal(memoryCalls, 2, 'replay never invokes automatic memory');
    await reopened.session.close();
  }
  console.log(
    'PASS independent adopted no-whole-adapter memory ' + mode,
    JSON.stringify({ calls: memoryCalls, events: events.length, requests: requests.length }),
  );
} finally {
  await session.close();
  await models.dispose();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
