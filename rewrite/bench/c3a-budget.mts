import assert from 'node:assert/strict';
import { AgentClient } from '../../source/lib/agent-client.ts';
import { sanitizePendingInteractionDto, projectPendingInteraction } from '../../source/gateway/interaction-protocol.ts';
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
const mode = process.env.PROBE_MODE || 'human';
let failFsync = false;
const fileSystem = new Proxy(fs, {
  get(target, key) {
    if (key === 'fsyncSync')
      return (fd: number) => {
        if (failFsync) {
          failFsync = false;
          throw new Error('injected budget fsync');
        }
        return target.fsyncSync(fd);
      };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
let requests: any[] = [];
const provider: any = {
  id: 'openai',
  label: 'Fixture',
  fetchModels: async () => [],
  capabilities: { supportsConversationChaining: false },
  createStreamedModel() {
    return {
      async *stream(request: any) {
        requests.push(request);
        const n = requests.length;
        const call = { type: 'tool_call', id: `call${n}`, name: 'missing_fixture_tool', arguments: '{}' };
        yield call;
        yield { type: 'completion', usage: { inputTokens: 11, outputTokens: 3 }, output: [call], responseId: `r${n}` };
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
      runBudget: {
        escalation: 'contain',
        maxUnpricedTokens: 14,
        maxParentExtensions: 0,
        extensionPercent: 100,
        warningHeadroomUnpricedTokens: 0,
        softHeadroomUnpricedTokens: 0,
      },
      retryAttempts: 0,
    } as any,
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
  fileSystem,
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
  assert.equal(first.interaction.variant, 'run_budget');
  assert.deepEqual(sanitizePendingInteractionDto(first.interaction).descriptor.runBudgetEvidence, {
    used: 14,
    limit: 14,
    headroom: 0,
  });
  const malformed = structuredClone(first.interaction);
  malformed.descriptor.argumentsText += '\t';
  assert.throws(() => sanitizePendingInteractionDto(malformed));
  malformed.descriptor.argumentsText = first.interaction.descriptor.argumentsText;
  malformed.descriptor.runBudgetEvidence.used = -1;
  assert.throws(() => sanitizePendingInteractionDto(malformed));
  const ordinary = { agentName: 'System', toolName: 'x', argumentsText: 'line\nline' };
  assert.throws(() => projectPendingInteraction(ordinary, 'x', 1));
  assert.equal(requests.length, 1);
  await assert.rejects(choose({ ...first, generation: 'stale' }, 'continue'));
  if (mode === 'refusal') {
    const original = AgentClient.prototype.grantRunBudgetExtension;
    AgentClient.prototype.grantRunBudgetExtension = () => ({ granted: false, extensionsGranted: 0 });
    try {
      await assert.rejects(choose(first, 'continue'), /No further budget extension is available/);
      assert.equal(facts().filter((f) => f.type === 'session_interaction_resolved').length, 0);
      assert.equal(session.state().pendingInteraction?.interaction.interactionId, first.interaction.interactionId);
      assert.equal(requests.length, 1);
    } finally {
      AgentClient.prototype.grantRunBudgetExtension = original;
    }
    await choose(first, 'stop');
    await settle('request1');
    assert.equal(requests.length, 1);
    console.log('PASS budget refusal and stop');
  } else if (mode === 'fault') {
    failFsync = true;
    await assert.rejects(choose(first, 'continue'));
    assert.equal(requests.length, 1);
    await assert.rejects(submission.submit({ requestId: 'after', input: { text: 'after fault' } }));
    assert.equal(facts().filter((f) => f.type === 'session_interaction_resolved').length, 0);
    console.log('PASS budget fsync fail closed');
  } else {
    await choose(first, 'continue');
    const second = await pending(1);
    assert.notEqual(second.interaction.interactionId, first.interaction.interactionId);
    await assert.rejects(choose(first, 'continue'));
    await choose(second, 'continue');
    const third = await pending(2);
    await choose(third, 'stop');
    await settle('request1');
    assert.equal(facts().filter((f) => f.type === 'session_interaction_resolved').length, 3);
    assert.equal(requests.length, 3);
    console.log('PASS actual human budget', JSON.stringify({ requests: requests.length, pending: 3 }));
  }
} finally {
  if (mode !== 'fault') await session.cancel();
  try {
    await session.close();
  } catch (error) {
    if (mode !== 'fault') throw error;
  }
  if (mode === 'fault') {
    const { session: reopened } = await store.openAdopted(session.id);
    assert.equal(reopened.state().status, 'interrupted');
    await reopened.close();
  }
  await models.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}
