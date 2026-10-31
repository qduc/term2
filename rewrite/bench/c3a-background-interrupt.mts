import { AgentClient } from '../../source/lib/agent-client.ts';
let capturedClient: any;
const capturedClients: any[] = [];
const originalSink = AgentClient.prototype.setBackgroundSubagentEventSink;
AgentClient.prototype.setBackgroundSubagentEventSink = function (...args: any[]) {
  if (args[0]) {
    capturedClient = this;
    capturedClients.push(this);
  }
  return originalSink.apply(this, args as any);
};
import { BackgroundShellRegistry } from '../../source/services/shell/background-shell-registry.ts';
import assert from 'node:assert/strict';
import { ModelBehaviorError } from '../../source/contracts/model-errors.ts';
import { AmbiguousModelOutcomeError, WebSocketReceiveTimeoutError } from '../../source/services/retry/retry-errors.ts';
import { UnsentWebSocketRequestError } from '../../source/providers/websocket-request-dispatch.ts';
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
async function makeGraph(label: string) {
  let releaseChild!: () => void, releaseForeground!: () => void;
  const childGate = new Promise<void>((r) => (releaseChild = r)),
    foregroundGate = new Promise<void>((r) => (releaseForeground = r));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-bench-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const target = path.join(workspace, 'effect.txt');
  const mode = 'background';
  const bg = new BackgroundShellRegistry();
  const limit = Number(process.env.RETRY_LIMIT ?? '2');
  let requests: any[] = [];
  let budgets: any[] = [];
  let budgetSnapshots: any[] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ index: requests.length }));
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
          budgets.push(request.recoveryBudget);
          budgetSnapshots.push(
            request.recoveryBudget && {
              physical: request.recoveryBudget.physicalAttempts,
              replays: request.recoveryBudget.automaticReplays,
              started: request.recoveryBudget.startedAt !== undefined,
            },
          );
          const response = await fetch(`http://127.0.0.1:${address.port}/model`, {
            method: 'POST',
            body: JSON.stringify({ tools: request.tools, input: request.input }),
          });
          const data: any = await response.json();
          const n = data.index;
          console.log(
            'REQUEST',
            n,
            JSON.stringify({
              input: request.input,
              tools: request.tools?.map((x: any) => x.name),
              instructions: request.instructions?.slice(0, 80),
            }),
          );
          if (n === 1) {
            const calls = [
              {
                type: 'tool_call',
                id: 'bg-shell',
                name: 'shell',
                arguments: JSON.stringify({
                  command: `printf '%s' "$$" > '${workspace}/bg.pid'; exec sleep 25`,
                  sandbox: 'unsandboxed',
                  background: true,
                  timeout_ms: 30000,
                  description: 'test',
                }),
              },
              {
                type: 'tool_call',
                id: 'bg-agent',
                name: 'run_subagent',
                arguments: JSON.stringify({
                  execution: 'background',
                  role: 'explorer',
                  task: 'Inspect the workspace and report.',
                }),
              },
            ];
            for (const c of calls) yield c;
            yield { type: 'completion', output: calls, responseId: 'root1' };
          } else if (request.tools?.some((x: any) => x.name === 'run_subagent') && n > 3) {
            await foregroundGate;
            yield {
              type: 'completion',
              output: [{ type: 'message', content: [{ type: 'text', text: 'late' }] }],
              responseId: 'late',
            };
          } else if (request.tools?.some((x: any) => x.name === 'run_subagent'))
            yield {
              type: 'completion',
              output: [{ type: 'message', content: [{ type: 'text', text: 'launched' }] }],
              responseId: 'root2',
            };
          else {
            await childGate;
          }
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
        retryAttempts: limit,
      } as any,
      memory: { enabled: false } as any,
      shell: { autoApproveMode: 'full' } as any,
    },
  });
  const readable = Object.keys(host.getAll()) as any;
  const pair = source.forSessionBinding(
    { readable, writable: [] },
    new Map([['shell.autoApproveMode', 'full']]) as any,
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
          allowBackgroundShell: true,
          backgroundShellRegistry: bg,
          toolOwnership: new ToolOwnershipRegistry(),
          deps: { settings: pair.service, logger, sessionContextService: context, executionContext },
        },
      }),
      onSourceEvent: (update) => events.push({ kind: 'source', ...update }),
      runtime: () => ({
        toolOwnership: new ToolOwnershipRegistry(),
        deps: { logger, settingsService: pair.service, sessionContextService: context },
      }),
    }),
  });
  const { session, submission } = await store.createAdopted(workspaceConfig, modelRef);

  const events: any[] = [];
  session.subscribe(0, (e) => events.push(e));
  async function until(fn: () => any, label: string) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error(`timeout ${label}: ${JSON.stringify(events)}`);
  }
  const facts = () => events.filter((e) => e.kind === 'fact').map((e) => e.entry.fact);
  const settle = (id: string) =>
    until(
      () => facts().find((f) => f.type === 'session_admission_settled' && f.clientRequestId === id),
      `settlement ${id}`,
    );
  return {
    session,
    submission,
    bg,
    requests,
    events,
    facts,
    settle,
    until,
    root,
    models,
    server,
    releaseChild,
    releaseForeground,
  };
}
async function launch(g: any) {
  await g.submission.submit({ requestId: 'request1', input: { text: 'Original input' } });
  const f = await g.until(() => g.facts().find((f: any) => f.type === 'session_interaction_pending'), 'approval');
  await g.submission.decide({
    kind: 'choose',
    turnId: f.turnId,
    interactionId: f.interaction.interactionId,
    revision: f.interaction.revision,
    generation: f.generation,
    decisions: [{ callId: f.interaction.descriptor.callId, choice: { answer: 'approve' } }],
  });
  await g.settle('request1');
  await g.until(() => fs.existsSync(path.join(g.root, 'workspace', 'bg.pid')), 'shell pid');
  assert.equal(g.bg.list()[0].status, 'running');
  const runEvent = g.events.find(
    (e: any) =>
      e.kind === 'source' && e.event.type === 'command_message' && e.event.message.toolName === 'run_subagent',
  );
  const id = JSON.parse(runEvent.event.message.output).runId;
  const client = capturedClients.find((c) => c.getBackgroundSubagentStatus(id).status === 'running');
  assert.ok(client);
  return { client, id };
}
const a = await makeGraph('a'),
  b = await makeGraph('b');
try {
  const ca = await launch(a),
    cb = await launch(b);
  const aCount = a.requests.length,
    bCount = b.requests.length;
  await a.session.cancel();
  assert.equal(a.bg.list()[0].status, 'running');
  assert.equal(ca.client.getBackgroundSubagentStatus(ca.id).status, 'running');
  assert.equal(b.bg.list()[0].status, 'running');
  assert.equal(cb.client.getBackgroundSubagentStatus(cb.id).status, 'running');
  assert.equal(a.requests.length, aCount);
  assert.equal(b.requests.length, bCount);
  console.log(
    'PASS TWO_GRAPH_FOREGROUND_CANCEL',
    JSON.stringify({
      aJobs: a.bg.list(),
      aChild: ca.client.getBackgroundSubagentStatus(ca.id),
      bJobs: b.bg.list(),
      bChild: cb.client.getBackgroundSubagentStatus(cb.id),
      aCount,
      bCount,
    }),
  );
  assert.equal(typeof a.submission.interruptFromUser, 'function');
  {
    await a.submission.submit({ requestId: 'held', input: { text: 'hold foreground' } });
    await a.until(() => a.requests.length > aCount, 'held foreground dispatch');
    const aPid = Number(fs.readFileSync(path.join(a.root, 'workspace', 'bg.pid'), 'utf8'));
    const foregroundCount = a.requests.length;
    let interruptSettled = false;
    const interrupt = a.submission.interruptFromUser().finally(() => {
      interruptSettled = true;
    });
    await a.until(
      () => a.bg.list()[0].status !== 'running' && ca.client.getBackgroundSubagentStatus(ca.id).status !== 'running',
      'background cancellation observation',
    );
    assert.equal(b.bg.list()[0].status, 'running');
    assert.equal(cb.client.getBackgroundSubagentStatus(cb.id).status, 'running');
    console.log('FOREGROUND_GATE_AT_BACKGROUND_OBSERVATION', JSON.stringify({ interruptSettled }));
    a.releaseForeground();
    a.releaseChild();
    await interrupt;
    await a.until(() => !['running', 'cancelling'].includes(a.bg.list()[0].status), 'shell terminal');
    await a.until(
      () => !['running', 'cancelling'].includes(ca.client.getBackgroundSubagentStatus(ca.id).status),
      'child terminal',
    );
    await a.until(() => {
      try {
        process.kill(aPid, 0);
        return false;
      } catch (e: any) {
        return e.code === 'ESRCH';
      }
    }, 'shell process exit');
    assert.equal(a.requests.length, foregroundCount);
    assert.equal(b.requests.length, bCount);
    console.log(
      'PASS INTERRUPT',
      JSON.stringify({
        aJobs: a.bg.list(),
        aChild: ca.client.getBackgroundSubagentStatus(ca.id),
        bJobs: b.bg.list(),
        bChild: cb.client.getBackgroundSubagentStatus(cb.id),
      }),
    );
    const bPid = Number(fs.readFileSync(path.join(b.root, 'workspace', 'bg.pid'), 'utf8'));
    await b.submission.interruptFromUser();
    b.releaseChild();
    await b.until(() => !['running', 'cancelling'].includes(b.bg.list()[0].status), 'idle shell terminal');
    await b.until(
      () => !['running', 'cancelling'].includes(cb.client.getBackgroundSubagentStatus(cb.id).status),
      'idle child terminal',
    );
    await b.until(() => {
      try {
        process.kill(bPid, 0);
        return false;
      } catch (e: any) {
        return e.code === 'ESRCH';
      }
    }, 'idle shell process exit');
    assert.equal(b.requests.length, bCount);
    console.log(
      'PASS IDLE_INTERRUPT',
      JSON.stringify({ jobs: b.bg.list(), child: cb.client.getBackgroundSubagentStatus(cb.id) }),
    );
  }
} finally {
  a.releaseChild();
  b.releaseChild();
  a.releaseForeground();
  b.releaseForeground();
  await Promise.allSettled([a.session.close(), b.session.close()]);
  await Promise.allSettled([a.models.dispose(), b.models.dispose()]);
  a.server.close();
  b.server.close();
  fs.rmSync(a.root, { recursive: true, force: true });
  fs.rmSync(b.root, { recursive: true, force: true });
}
