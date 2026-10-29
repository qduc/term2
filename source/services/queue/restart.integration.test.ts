import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QueueController, type QueuePersistence } from './queue-controller.js';
import { ConversationAdapter } from '../conversation/conversation-adapter.js';

const roots: string[] = [];
const store = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-restart-'));
  roots.push(root);
  const file = path.join(root, 'queue.json');
  const persistence: QueuePersistence = {
    load: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null),
    replace: (record) => fs.writeFileSync(file, JSON.stringify(record)),
  };
  return { file, persistence };
};
const queue = (persistence: QueuePersistence, completionBarrier?: () => void) =>
  new QueueController({
    persistence,
    driver: { start: () => undefined, cancel: () => true },
    snapshotFactory: (item) => ({ requestId: item.id }),
    completionBarrier,
  });
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('restart handoff against actual queue storage', () => {
  it('retains human arrival through adapter admission, filesystem queue recovery and dispatch', async () => {
    const { persistence } = store();
    const seed = queue(persistence);
    seed.holdDispatch();
    await seed.command({ kind: 'submit', id: 'seed', text: 'old retained input' });
    const deps = {
      sessionId: 'timing-restart',
      startedAt: '2026-10-29T00:00:00.000Z',
      queueForeground: true,
      queuePersistence: persistence,
      logger: { info() {}, warn() {}, error() {}, debug() {}, getCorrelationId: () => undefined },
      sessionContextService: { runWithContext: (_context: unknown, run: () => unknown) => run() },
      userTurns: { listUserTurns: () => [] },
      logs: { dispatchEventToLog() {} },
      approval: {},
      turnFlow: {},
    };
    const adapter = new ConversationAdapter(deps as any);
    let admitted!: () => void;
    const admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    void adapter
      .submitMessage(
        { text: 'timed pending human', humanInputAt: '2026-10-29T02:00:00.000Z' },
        {
          preferredMessageId: 'timed',
          onAdmission: admitted,
        },
      )
      .catch(() => undefined);
    await admission;
    const release = await adapter.prepareRestart();
    const record = persistence.load() as any;
    expect(record.queue.find((item: any) => item.id === 'timed').humanInputAt).toBe('2026-10-29T02:00:00.000Z');
    release();
    let dispatch!: (turn: unknown) => void;
    const dispatched = new Promise<any>((resolve) => {
      dispatch = resolve;
    });
    const restored = new ConversationAdapter({
      ...deps,
      turnFlow: {
        async *start(turn: any) {
          if (turn.text === 'timed pending human') dispatch(turn);
          yield { type: 'final', finalText: 'done' };
        },
      },
    } as any);
    await restored.resumeQueue();
    expect((await dispatched).humanInputAt).toBe('2026-10-29T02:00:00.000Z');
  });

  it('retains plain input exactly once and paused across reconstruction and reversible hold', async () => {
    const { file, persistence } = store();
    const first = queue(persistence);
    expect(first.holdDispatch()).toBe(true);
    await first.command({ kind: 'submit', id: 'one', text: 'keep this text' });
    await first.assertRestartDurable();
    const raw = fs.readFileSync(file, 'utf8');
    const restored = queue(persistence);
    expect(restored.state().kind).toBe('paused');
    expect(restored.holdDispatch()).toBe(false);
    expect(restored.holdDispatch({ allowPaused: true })).toBe(true);
    await restored.assertRestartDurable();
    restored.releaseDispatch();
    expect(restored.state().kind).toBe('paused');
    expect(restored.state().queue.map((item) => item.id)).toEqual(['one']);
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
  });

  it.each(['missing', 'invalid', 'changed', 'extra'])(
    'refuses %s pending storage without repairing it',
    async (fault) => {
      const { file, persistence } = store();
      const q = queue(persistence);
      q.holdDispatch();
      await q.command({ kind: 'submit', id: 'one', text: 'original' });
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (fault === 'missing') fs.unlinkSync(file);
      if (fault === 'invalid') fs.writeFileSync(file, '{}');
      if (fault === 'changed') {
        record.queue[0].text = 'lost change';
        fs.writeFileSync(file, JSON.stringify(record));
      }
      if (fault === 'extra') {
        record.queue.push({ ...record.queue[0], id: 'stale', sequence: 99 });
        fs.writeFileSync(file, JSON.stringify(record));
      }
      const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      await expect(q.assertRestartDurable()).rejects.toThrow();
      expect(q.state().queue[0]?.text).toBe('original');
      expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null).toBe(before);
    },
  );

  it('checks stale disk input even when memory is empty; permits a truly fresh empty queue', async () => {
    const { file, persistence } = store();
    const empty = queue(persistence);
    empty.holdDispatch();
    await empty.assertRestartDurable();
    const other = queue(persistence);
    other.holdDispatch();
    await other.command({ kind: 'submit', text: 'stale disk entry' });
    await expect(empty.assertRestartDurable()).rejects.toThrow('differs');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).queue).toHaveLength(1);
  });

  it('proves actual successful storage despite a stale persistence-failure diagnostic', async () => {
    const { file, persistence } = store();
    const q = queue(persistence);
    fs.mkdirSync(file);
    q.holdDispatch();
    await q.command({ kind: 'submit', id: 'one', text: 'before repair' });
    fs.rmdirSync(file);
    await q.command({ kind: 'edit_queued', itemId: q.state().queue[0]!.id, text: 'repaired' });
    expect(q.state().recovery?.kind).toBe('persistence_failed');
    await q.assertRestartDurable();
    // Reconstruct from the real repaired file rather than the failing diagnostic.
    const restored = queue(persistence);
    restored.holdDispatch({ allowPaused: true });
    await restored.assertRestartDurable();
    expect(restored.state().queue[0]?.text).toBe('repaired');
  });

  it('does not replay a stale persisted active record, while retaining its pending successor', async () => {
    const { persistence } = store();
    const first = queue(persistence);
    await first.command({ kind: 'submit', id: 'interrupted', text: 'must not replay' });
    await first.command({ kind: 'submit', id: 'pending', text: 'must retain' });
    const restored = queue(persistence);
    expect(restored.state().kind).toBe('paused');
    expect(restored.state().queue.map((item) => item.id)).toEqual(['pending']);
    expect(restored.holdDispatch({ allowPaused: true })).toBe(true);
    await restored.assertRestartDurable();
  });

  it('keeps completion-barrier holds working with the completing execution still present', async () => {
    const { persistence } = store();
    let held = false;
    const q = queue(persistence, () => {
      held = q.holdDispatch({ afterCompletion: true });
    });
    await q.command({ kind: 'submit', id: 'active', text: 'first' });
    await q.command({ kind: 'submit', id: 'next', text: 'next' });
    const active = q.state();
    if (active.kind !== 'running') throw new Error('Fixture did not start');
    await q.event({ kind: 'completed', executionId: active.active.executionId, terminal: undefined });
    expect(held).toBe(true);
    expect(q.state().kind).toBe('idle');
    await q.assertRestartDurable();
    expect(q.state().queue[0]?.id).toBe('next');
  });

  it.each([false, true])(
    'adapter holds admission and releases without losing paused input (volatile=%s)',
    async (rich) => {
      const { persistence } = store();
      const seed = queue(persistence);
      seed.holdDispatch();
      await seed.command({ kind: 'submit', id: 'seed', text: 'retained text' });
      // Only external turn-execution dependencies are inert: this fixture must never dispatch.
      const adapter = new ConversationAdapter({
        sessionId: 'restart-test',
        startedAt: new Date().toISOString(),
        queueForeground: true,
        queuePersistence: persistence,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        sessionContextService: {},
        userTurns: { listUserTurns: () => [] },
        logs: {},
        approval: {},
        turnFlow: {},
      } as any);
      let admitted!: () => void;
      const admission = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      void adapter
        .submitMessage(
          rich ? { text: 'rich', skill: { name: 's', description: 'fixture skill', body: 'not on disk' } } : 'plain',
          {
            preferredMessageId: 'new',
            onAdmission: admitted,
          },
        )
        .catch(() => undefined);
      await admission;
      if (rich) {
        await expect(adapter.prepareRestart()).rejects.toThrow('new');
        expect(adapter.queueStateKind()).toBe('paused');
      } else {
        const release = await adapter.prepareRestart();
        await expect(adapter.submitMessage('too late')).rejects.toThrow(/restart/i);
        release();
        release();
        expect(adapter.queueStateKind()).toBe('paused');
        expect(persistence.load()).toMatchObject({ queue: [{ id: 'seed' }, { id: 'new' }] });
      }
    },
  );
});
