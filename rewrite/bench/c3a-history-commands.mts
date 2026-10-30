import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalSessionStore } from '../src/session/local-store.ts';
import { CanonicalSessionLog } from '../src/session/adopted/conversation-log.ts';
import { createAppAdoptedSessionHandleFactory } from '../src/app/adopted/session.ts';
import { createAdoptedSettings } from '../src/config/adopted/settings.ts';
import { createAdoptedModelRegistry } from '../src/model/adopted/index.ts';
import { createProviderRegistry } from '../../source/providers/registry.ts';
import { SessionContextService } from '../../source/services/session/session-context-service.ts';
import { LoggingService } from '../../source/services/logging/logging-service.ts';
import { ExecutionContext } from '../../source/services/execution-context.ts';
import { ToolOwnershipRegistry } from '../../source/services/approval/tool-ownership-registry.ts';
import { SessionLifecycle } from '../../source/services/session/session-lifecycle.ts';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c3a-history-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
const requests: any[] = [];
const mode = process.env.PROBE_MODE ?? 'basic';
let undoCalls = 0;
const undoOriginal = SessionLifecycle.prototype.undoLastUserTurn;
SessionLifecycle.prototype.undoLastUserTurn = function () {
  undoCalls++;
  return undoOriginal.call(this);
};
let undoWritten = false;
const faultFs = new Proxy(fs, {
  get(target, key) {
    if (key === 'writeSync')
      return (...args: any[]) => {
        if (String(args[1]).includes('"type":"undo"')) undoWritten = true;
        return (fs.writeSync as any)(...args);
      };
    if (key === 'fsyncSync')
      return (...args: any[]) => {
        if (mode === 'fsync' && undoWritten) throw new Error('injected undo fsync');
        return (fs.fsyncSync as any)(...args);
      };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
const provider: any = {
  id: 'openai',
  label: 'fixture',
  fetchModels: async () => [],
  capabilities: { supportsConversationChaining: false },
  createStreamedModel() {
    return {
      async *stream(request: any) {
        requests.push(request.input);
        if (mode === 'held' && requests.length === 3) await gate;
        yield {
          type: 'completion',
          output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
          responseId: 'fixture',
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
const pair = source.forSessionBinding({ readable: Object.keys(host.getAll()) as any, writable: [] });
const logger = new LoggingService({ disableLogging: true });
const models = createAdoptedModelRegistry({
  settingsService: pair.service,
  loggingService: logger,
  sessionContextService: new SessionContextService(),
  providerRegistry: providers,
  ownership: 'borrowed',
});
const workspaceConfig: any = { root: workspace, access: 'read_write', target: 'local' };
const modelRef: any = { provider: 'openai', model: 'fixture' };
let ownership: ToolOwnershipRegistry;
let graphContext: SessionContextService;
const store = new LocalSessionStore({
  fileSystem: faultFs,
  root: path.join(root, 'sessions'),
  logger,
  defaultWorkspace: workspaceConfig,
  defaultModel: modelRef,
  driverFactory: () => {
    throw new Error('combined handle expected');
  },
  adoptedHandleFactory: createAppAdoptedSessionHandleFactory({
    engine: () => {
      ownership = new ToolOwnershipRegistry();
      graphContext = new SessionContextService();
      const execution = new ExecutionContext();
      execution.enterWorkspace(workspace);
      return {
        models,
        settings: pair.settings,
        clientOptions: {
          selection: { provider: 'openai', model: 'fixture' },
          toolOwnership: ownership,
          deps: { settings: pair.service, logger, sessionContextService: graphContext, executionContext: execution },
        },
      };
    },
    runtime: () => ({
      toolOwnership: ownership,
      deps: { logger, settingsService: pair.service, sessionContextService: graphContext },
    }),
  }),
});
const { session, submission } = await store.createAdopted(workspaceConfig, modelRef);
const updates: any[] = [];
session.subscribe(0, (event) => updates.push(event));
async function send(id: string, text: string, images?: any[]) {
  await submission.submit({ requestId: id, input: { text, ...(images ? { images } : {}) } });
  const until = Date.now() + 10000;
  while (
    !updates.some(
      (e) =>
        e.kind === 'fact' && e.entry.fact.type === 'session_admission_settled' && e.entry.fact.clientRequestId === id,
    )
  ) {
    if (Date.now() > until) throw new Error('settlement timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
try {
  await send('a', 'same');
  const images = [{ id: 'image', data: 'aGVsbG8=', mimeType: 'image/png', byteSize: 5, displayNumber: 1 }];
  await send('b', 'same', images);
  if (mode === 'fsync') {
    await assert.rejects(submission.history({ kind: 'undo_last' }), /injected|Persistence/);
    assert.equal(undoCalls, 1);
    await assert.rejects(submission.history({ kind: 'undo_last' }), /injected|Persistence/);
    assert.equal(undoCalls, 1, 'poison prevents second source mutation');
    assert.equal(requests.length, 2);
    try {
      await session.close();
    } catch {
      /* writer remains poisoned */
    }
    console.log('PASS fsync poison prevents success and repeat mutation');
  } else if (mode === 'held') {
    await submission.submit({ requestId: 'held', input: { text: 'held' } });
    const until = Date.now() + 10000;
    while (requests.length !== 3) {
      if (Date.now() > until) throw new Error('held request timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
    const before = JSON.stringify(session.state());
    assert.equal((await submission.history({ kind: 'rewind', targetId: 'bad' })).kind, 'stale');
    assert.equal(JSON.stringify(session.state()), before, 'invalid target does not cancel held owner');
    const heldTargets = await submission.listRewindTargets();
    let settled = false;
    const undo = submission.history({ kind: 'rewind', targetId: heldTargets[0]!.id });
    const duplicate = submission.history({ kind: 'rewind', targetId: heldTargets[0]!.id });
    assert.equal(duplicate, undo, 'duplicate command shares in-flight result');
    void undo.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(settled, false, 'accepted command waits for physical provider settlement');
    release();
    assert.deepEqual(await undo, { kind: 'applied', restored: { text: 'same' } });
    assert.equal((await submission.listRewindTargets()).length, 0);
    const log = CanonicalSessionLog.readOnly(path.join(root, 'sessions'), session.id);
    assert.equal(log.filter((entry: any) => entry.fact.type === 'undo').length, 1);
    await session.close();
    console.log('PASS held owner stale no-op and accepted physical settlement');
  } else {
    const targets = await submission.listRewindTargets();
    assert.equal(targets.length, 2);
    const state = JSON.stringify(session.state());
    assert.equal((await submission.history({ kind: 'rewind', targetId: 'bad' })).kind, 'stale');
    assert.equal(JSON.stringify(session.state()), state);
    assert.deepEqual(await submission.history({ kind: 'undo_count', count: 0 }), { kind: 'not_found' });
    assert.equal(JSON.stringify(session.state()), state);
    const removed = await submission.history({ kind: 'rewind', targetId: targets[1]!.id });
    assert.equal(removed.kind, 'applied');
    if (removed.kind !== 'applied') throw new Error('undo did not apply');
    assert.equal(removed.restored.text, 'same');
    assert.deepEqual(
      removed.restored.images?.map(({ id: _id, ...image }) => image),
      images.map(({ id: _id, ...image }) => image),
    );
    assert.equal((await submission.listRewindTargets()).length, 1);
    assert.equal((await submission.history({ kind: 'rewind', targetId: targets[0]!.id })).kind, 'stale');
    await send('c', 'after');
    assert.equal(requests.length, 3);
    const log = CanonicalSessionLog.readOnly(path.join(root, 'sessions'), session.id);
    assert.equal(log.filter((entry: any) => entry.fact.type === 'undo').length, 1);
    await session.close();
    await assert.rejects(submission.history({ kind: 'undo_last' }), /closed/);
    const reopened = await store.openAdopted(session.id);
    assert.equal((await reopened.submission.listRewindTargets()).length, 2);
    assert.deepEqual(await reopened.submission.history({ kind: 'undo_count', count: 9 }), {
      kind: 'applied',
      restored: { text: 'same' },
    });
    assert.equal((await reopened.submission.listRewindTargets()).length, 0);
    await reopened.session.close();
    const empty = await store.openAdopted(session.id);
    assert.equal((await empty.submission.listRewindTargets()).length, 0);
    await empty.session.close();
    console.log('PASS history reservation, stale target, undo and cold reopen');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
