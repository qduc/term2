import assert from 'node:assert/strict';
import { AgentClient } from '../../source/lib/agent-client.ts';
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
const mode = process.env.PROBE_MODE || 'normal';
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
        yield {
          type: 'completion',
          output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
          responseId: `r${requests.length}`,
          usage: { inputTokens: 3, outputTokens: 2 },
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
      temperature: 0.7,
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

const other = await store.createAdopted(workspaceConfig, modelRef);
const events: any[] = [];
session.subscribe(0, (e) => events.push(e));
const until = async (id: string) => {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (
      events.some(
        (e) =>
          e.kind === 'fact' && e.entry.fact.type === 'session_admission_settled' && e.entry.fact.clientRequestId === id,
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('settle timeout ' + JSON.stringify(events));
};
await (async () => {
  try {
    const baseline = CanonicalSessionLog.readOnly(path.join(root, 'sessions'), session.id).find(
      (e) => e.fact.type === 'session_settings_initialized',
    );
    assert.ok(baseline);
    assert.equal((baseline.fact as any).temperature, 0.7);
    if (mode === 'fault') {
      failFsync = true;
      await assert.rejects(submission.setRuntimeSettings({ kind: 'temperature', temperature: 0.2 }));
      await assert.rejects(submission.submit({ requestId: 'after', input: { text: 'no' } }));
      await assert.rejects(session.closeLog());
      assert.equal(requests.length, 0);
      console.log('PASS settings fsync poison');
      return;
    }
    if (mode === 'partial') {
      const setter = AgentClient.prototype.setTemperature;
      AgentClient.prototype.setTemperature = function (value) {
        setter.call(this, value);
        throw new Error('partial setter');
      };
      try {
        await assert.rejects(
          submission.setRuntimeSettings({ kind: 'temperature', temperature: 0.2 }),
          /partial setter/,
        );
      } finally {
        AgentClient.prototype.setTemperature = setter;
      }
      await assert.rejects(submission.submit({ requestId: 'after', input: { text: 'no' } }));
      await assert.rejects(session.closeLog());
      assert.equal(requests.length, 0);
      console.log('PASS settings partial setter poison');
      return;
    }
    if (mode === 'unsupported') {
      const setter = AgentClient.prototype.setTemperature;
      (AgentClient.prototype as any).setTemperature = undefined;
      const seq = session.state().lastSeq;
      try {
        assert.deepEqual(await submission.setRuntimeSettings({ kind: 'temperature', temperature: 0.2 }), {
          kind: 'unsupported',
        });
      } finally {
        AgentClient.prototype.setTemperature = setter;
      }
      assert.equal(session.state().lastSeq, seq);
      console.log('PASS settings unsupported pure');
      return;
    }

    const first = submission.setRuntimeSettings({ kind: 'temperature', temperature: 0.2 });
    const duplicate = submission.setRuntimeSettings({ kind: 'temperature', temperature: 0.2 });
    assert.equal(first, duplicate);
    assert.equal((await first).kind, 'applied');
    assert.equal(
      (
        await submission.setRuntimeSettings({
          kind: 'model',
          selection: { provider: ' openai ', model: ' fixture-b ' },
        })
      ).kind,
      'applied',
    );
    assert.deepEqual(session.state().model, { provider: 'openai', model: 'fixture-b' });
    assert.equal((await submission.setRuntimeSettings({ kind: 'reasoning', effort: 'high' })).kind, 'applied');
    assert.equal(host.get('agent.temperature'), 0.7);
    await submission.submit({ requestId: 'r1', input: { text: 'test' } });
    await until('r1');
    assert.equal(requests[0].temperature, 0.2);
    assert.equal(requests[0].reasoning?.effort, 'high');
    const otherEvents: any[] = [];
    other.session.subscribe(0, (e) => otherEvents.push(e));
    await other.submission.submit({ requestId: 'other', input: { text: 'other' } });
    const end = Date.now() + 12000;
    while (
      !otherEvents.some((e) => e.kind === 'fact' && e.entry.fact.type === 'session_admission_settled') &&
      Date.now() < end
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(requests[1].temperature, 0.7);
    await submission.setRuntimeSettings({ kind: 'temperature' });
    await session.close();
    const reopened = await store.openAdopted(session.id);
    const reopenEvents: any[] = [];
    reopened.session.subscribe(0, (e) => reopenEvents.push(e));
    await reopened.submission.submit({ requestId: 'r2', input: { text: 'again' } });
    const end2 = Date.now() + 12000;
    while (
      !reopenEvents.some(
        (e) =>
          e.kind === 'fact' &&
          e.entry.fact.type === 'session_admission_settled' &&
          e.entry.fact.clientRequestId === 'r2',
      ) &&
      Date.now() < end2
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(requests[2].temperature, undefined);
    await reopened.session.close();
    console.log('PASS settings normal two graph unset reopen');
  } finally {
    await session.close().catch(() => {});
    await other.session.close();
    await models.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
