import { describe, expect, it, vi } from 'vitest';
import {
  BackgroundSubagentApprovalQueue,
  type BackgroundSubagentApprovalCallbacks,
  type BackgroundSubagentApprovalEntry,
} from './background-subagent-approval-queue.js';

const entry = (
  toolCallId: string,
  overrides: Partial<BackgroundSubagentApprovalEntry> = {},
): BackgroundSubagentApprovalEntry => ({
  runId: 'run-a',
  generation: 1,
  toolCallId,
  toolName: 'shell',
  argumentsText: JSON.stringify({ command: toolCallId }),
  ...overrides,
});

const enqueue = (
  queue: BackgroundSubagentApprovalQueue,
  pending: BackgroundSubagentApprovalEntry,
  callbacks: Partial<BackgroundSubagentApprovalCallbacks> = {},
) => queue.enqueue(pending, { onResolve: vi.fn(() => ({ kind: 'applied' as const })), ...callbacks });

describe('BackgroundSubagentApprovalQueue', () => {
  it('publishes an immutable revisioned FIFO head and hides later runs until their turn', () => {
    const queue = new BackgroundSubagentApprovalQueue();
    const first = entry('call-a');
    const second = entry('call-b', { runId: 'run-b', generation: 4 });
    const observed: number[] = [];
    const unsubscribe = queue.subscribe(() => observed.push(queue.getSnapshot().revision));

    expect(queue.getSnapshot()).toEqual({ revision: 0, current: null, pendingCount: 0, closed: false });
    expect(enqueue(queue, first)).toEqual({ kind: 'enqueued', revision: 1 });
    expect(enqueue(queue, second)).toEqual({ kind: 'enqueued', revision: 2 });

    const snapshot = queue.getSnapshot();
    expect(snapshot).toEqual({ revision: 2, current: first, pendingCount: 2, closed: false });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.current)).toBe(true);
    expect(observed).toEqual([1, 2]);

    unsubscribe();
  });

  it('delivers only the exact current entry once and exposes the next FIFO entry', () => {
    const queue = new BackgroundSubagentApprovalQueue();
    const first = entry('call-a');
    const second = entry('call-b');
    const firstResolved = vi.fn(() => ({ kind: 'applied' as const }));
    enqueue(queue, first, { onResolve: firstResolved });
    enqueue(queue, second);

    const firstSnapshot = queue.getSnapshot();
    expect(
      queue.resolve({
        revision: firstSnapshot.revision,
        entry: firstSnapshot.current!,
        decision: { answer: 'y' },
      }),
    ).toEqual({ kind: 'resolved', entry: first, decision: { answer: 'y' } });
    expect(firstResolved).toHaveBeenCalledWith(first, { answer: 'y' });
    expect(queue.getSnapshot()).toEqual({ revision: 3, current: second, pendingCount: 1, closed: false });

    expect(queue.resolve({ revision: firstSnapshot.revision, entry: first, decision: { answer: 'y' } })).toEqual({
      kind: 'stale',
      reason: 'revision_mismatch',
    });
  });

  it('rejects a stale identity without claiming the current approval', () => {
    const queue = new BackgroundSubagentApprovalQueue();
    const original = entry('call-a');
    enqueue(queue, original);
    const snapshot = queue.getSnapshot();

    expect(
      queue.resolve({
        revision: snapshot.revision,
        entry: { ...original, argumentsText: '{"command":"other"}' },
        decision: { answer: 'n', rejectionReason: 'not this command' },
      }),
    ).toEqual({ kind: 'stale', reason: 'identity_mismatch' });
    expect(queue.getSnapshot()).toBe(snapshot);
  });

  it('updates and removes an exact queued entry while retaining FIFO order', () => {
    const queue = new BackgroundSubagentApprovalQueue();
    const first = entry('call-a');
    const second = entry('call-b');
    const released = vi.fn();
    enqueue(queue, first);
    enqueue(queue, second, { onRelease: released });
    const beforeUpdate = queue.getSnapshot();
    const updated = { ...second, metadata: { source: 'continued-segment' } };

    expect(queue.update({ revision: beforeUpdate.revision, expected: second, entry: updated })).toEqual({
      kind: 'updated',
      revision: 3,
    });
    expect(queue.getSnapshot()).toMatchObject({ current: first, pendingCount: 2, revision: 3 });
    const beforeRemove = queue.getSnapshot();
    expect(queue.remove({ revision: beforeRemove.revision, entry: updated })).toEqual({ kind: 'removed', revision: 4 });
    expect(released).toHaveBeenCalledWith(updated, { kind: 'removed' });
    expect(queue.getSnapshot()).toMatchObject({ current: first, pendingCount: 1, revision: 4 });

    expect(queue.remove({ revision: beforeRemove.revision, entry: updated })).toEqual({
      kind: 'stale',
      reason: 'revision_mismatch',
    });
  });

  it('promotes the next entry when the FIFO head is removed', () => {
    const queue = new BackgroundSubagentApprovalQueue();
    const first = entry('call-a');
    const second = entry('call-b', { runId: 'run-b', generation: 2 });
    const firstReleased = vi.fn();
    enqueue(queue, first, { onRelease: firstReleased });
    enqueue(queue, second);
    const snapshot = queue.getSnapshot();

    expect(queue.remove({ revision: snapshot.revision, entry: first })).toEqual({ kind: 'removed', revision: 3 });
    expect(firstReleased).toHaveBeenCalledWith(first, { kind: 'removed' });
    expect(queue.getSnapshot()).toEqual({ revision: 3, current: second, pendingCount: 1, closed: false });
  });

  it('closes terminally, releases every queued entry explicitly, and rejects later operations', () => {
    const queue = new BackgroundSubagentApprovalQueue();
    const first = entry('call-a');
    const second = entry('call-b');
    const firstReleased = vi.fn();
    const secondReleased = vi.fn();
    enqueue(queue, first, { onRelease: firstReleased });
    enqueue(queue, second, { onRelease: secondReleased });

    queue.close();
    queue.close();

    expect(firstReleased).toHaveBeenCalledTimes(1);
    expect(firstReleased).toHaveBeenCalledWith(first, { kind: 'closed' });
    expect(secondReleased).toHaveBeenCalledTimes(1);
    expect(secondReleased).toHaveBeenCalledWith(second, { kind: 'closed' });
    expect(queue.getSnapshot()).toEqual({ revision: 3, current: null, pendingCount: 0, closed: true });
    expect(enqueue(queue, entry('late'))).toEqual({ kind: 'closed' });
    expect(queue.resolve({ revision: 3, entry: first, decision: { answer: 'y' } })).toEqual({ kind: 'closed' });
    expect(queue.update({ revision: 3, expected: first, entry: first })).toEqual({ kind: 'closed' });
    expect(queue.remove({ revision: 3, entry: first })).toEqual({ kind: 'closed' });
  });

  it('notifies each listener once per revision despite unsubscribe and reentrant changes', () => {
    const queue = new BackgroundSubagentApprovalQueue();
    const firstRevisions: number[] = [];
    const secondRevisions: number[] = [];
    const unsubscribeFirst = queue.subscribe(() => {
      firstRevisions.push(queue.getSnapshot().revision);
      unsubscribeFirst();
    });
    queue.subscribe(() => {
      const revision = queue.getSnapshot().revision;
      secondRevisions.push(revision);
      if (revision === 1) enqueue(queue, entry('call-b'));
    });

    enqueue(queue, entry('call-a'));

    expect(firstRevisions).toEqual([1]);
    expect(secondRevisions).toEqual([1, 2]);
  });

  it('keeps the current entry unpublished until its resolve callback succeeds', () => {
    const queue = new BackgroundSubagentApprovalQueue();
    const first = entry('call-a');
    const second = entry('call-b', { runId: 'run-b' });
    const observer = vi.fn();
    queue.subscribe(observer);
    let attempts = 0;
    const apply = vi.fn(() => {
      attempts += 1;
      expect(queue.getSnapshot()).toBe(beforeResolve);
      expect(queue.resolve({ revision: beforeResolve.revision, entry: second, decision: { answer: 'y' } })).toEqual({
        kind: 'stale',
        reason: 'identity_mismatch',
      });
      if (attempts === 1) throw new Error('lease application failed');
      return { kind: 'applied' as const };
    });
    enqueue(queue, first, { onResolve: apply });
    enqueue(queue, second);
    const beforeResolve = queue.getSnapshot();
    observer.mockClear();

    expect(() => queue.resolve({ revision: beforeResolve.revision, entry: first, decision: { answer: 'y' } })).toThrow(
      'lease application failed',
    );
    expect(queue.getSnapshot()).toBe(beforeResolve);
    expect(observer).not.toHaveBeenCalled();

    expect(queue.resolve({ revision: beforeResolve.revision, entry: first, decision: { answer: 'y' } })).toEqual({
      kind: 'resolved',
      entry: first,
      decision: { answer: 'y' },
    });
    expect(queue.getSnapshot()).toMatchObject({ current: second, revision: beforeResolve.revision + 1 });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('retains the same head and snapshot when the lease rejects application', () => {
    const queue = new BackgroundSubagentApprovalQueue();
    const first = entry('call-a');
    const second = entry('call-b');
    const rejectApplication = vi.fn(() => ({ kind: 'rejected' as const }));
    enqueue(queue, first, { onResolve: rejectApplication });
    enqueue(queue, second);
    const snapshot = queue.getSnapshot();

    expect(queue.resolve({ revision: snapshot.revision, entry: first, decision: { answer: 'y' } })).toEqual({
      kind: 'apply_rejected',
      entry: first,
    });
    expect(rejectApplication).toHaveBeenCalledWith(first, { answer: 'y' });
    expect(queue.getSnapshot()).toBe(snapshot);
    expect(queue.getSnapshot().current).toEqual(first);
  });

  it('isolates release callback failures while removing and closing entries exactly once', () => {
    const queue = new BackgroundSubagentApprovalQueue();
    const first = entry('call-a');
    const second = entry('call-b');
    const third = entry('call-c');
    const removeError = new Error('remove release failed');
    const closeError = new Error('close release failed');
    const firstRelease = vi.fn(() => {
      throw removeError;
    });
    const secondRelease = vi.fn(() => {
      throw closeError;
    });
    const thirdRelease = vi.fn();
    enqueue(queue, first, { onRelease: firstRelease });
    enqueue(queue, second, { onRelease: secondRelease });
    enqueue(queue, third, { onRelease: thirdRelease });

    expect(queue.remove({ revision: 3, entry: first })).toEqual({
      kind: 'removed',
      revision: 4,
      releaseErrors: [removeError],
    });
    expect(queue.close()).toEqual([closeError]);
    expect(queue.close()).toEqual([]);
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(secondRelease).toHaveBeenCalledTimes(1);
    expect(thirdRelease).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot()).toEqual({ revision: 5, current: null, pendingCount: 0, closed: true });
  });

  it('deep-clones and freezes metadata before publishing it', () => {
    const queue = new BackgroundSubagentApprovalQueue();
    const metadata = { deniedRead: { path: '/private/a' }, choices: ['once', 'deny'] };
    enqueue(queue, entry('call-a', { metadata }));
    metadata.deniedRead.path = '/mutated';
    metadata.choices.push('remember');

    const published = queue.getSnapshot().current!.metadata!;
    expect(published).toEqual({ deniedRead: { path: '/private/a' }, choices: ['once', 'deny'] });
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.deniedRead)).toBe(true);
    expect(Object.isFrozen(published.choices)).toBe(true);
  });

  it('does not spin when a listener unsubscribes and resubscribes during notification', () => {
    const queue = new BackgroundSubagentApprovalQueue();
    const revisions: number[] = [];
    const listener = () => {
      revisions.push(queue.getSnapshot().revision);
      unsubscribe();
      unsubscribe = queue.subscribe(listener);
    };
    let unsubscribe = queue.subscribe(listener);

    enqueue(queue, entry('call-a'));
    enqueue(queue, entry('call-b'));

    expect(revisions).toEqual([1, 2]);
    unsubscribe();
  });
});
