import { describe, expect, it } from 'vitest';
import { LiveRun } from './live-run.js';
import { PostExecutePendingRegistry } from './post-execute-pending-registry.js';

describe('LiveRun', () => {
  it('fails closed for gates belonging to a stream that fails', async () => {
    const pending = new PostExecutePendingRegistry({ sessionId: 'session-a', epoch: 1 });
    const gate = pending.register({
      runId: 'run-a',
      toolCallId: 'call-a',
      toolName: 'shell',
      argumentsText: '{}',
    });
    const run = new LiveRun('run-a', pending, async () => {
      throw new Error('stream failed');
    });

    await expect(run.completion).rejects.toThrow('stream failed');
    await expect(gate).resolves.toBe('reject');
    expect(pending.entriesForRun('run-a')).toEqual([]);
  });

  it('keeps unselected entries in the authoritative snapshot', async () => {
    const pending = new PostExecutePendingRegistry({ sessionId: 'session-a', epoch: 1 });
    const first = pending.register({ runId: 'run-a', toolCallId: 'call-a', toolName: 'shell', argumentsText: '{}' });
    const second = pending.register({ runId: 'run-a', toolCallId: 'call-b', toolName: 'shell', argumentsText: '{}' });
    const snapshot = pending.snapshot();

    pending.decide({ revision: snapshot.revision, ids: [snapshot.entries[0].id], decision: 'approve' });
    await expect(first).resolves.toBe('approve');
    expect(pending.snapshot().entries.map((entry) => entry.toolCallId)).toEqual(['call-b']);
    pending.close();
    await expect(second).resolves.toBe('reject');
  });

  it('cancels gates, wakes a waiting consumer, and suppresses late events', async () => {
    const pending = new PostExecutePendingRegistry({ sessionId: 'session-a', epoch: 1 });
    let emit!: (event: string) => void;
    const run = new LiveRun('run-a', pending, async (publish) => {
      emit = publish;
      return await new Promise<string>(() => {});
    });

    const waiting = run.next();
    await Promise.resolve();
    const gate = pending.register({ runId: 'run-a', toolCallId: 'call-a', toolName: 'shell', argumentsText: '{}' });
    run.cancel();
    emit('late');

    await expect(gate).resolves.toBe('reject');
    await expect(waiting).resolves.toEqual({ kind: 'cancelled' });
    await expect(run.next()).resolves.toEqual({ kind: 'cancelled' });
  });
});
