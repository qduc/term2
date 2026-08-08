import { describe, expect, it, vi } from 'vitest';
import {
  BackgroundSubagentApprovalQueue,
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

describe('BackgroundSubagentApprovalQueue', () => {
  it('publishes an immutable revisioned FIFO head and hides later runs until their turn', () => {
    const queue = new BackgroundSubagentApprovalQueue();
    const first = entry('call-a');
    const second = entry('call-b', { runId: 'run-b', generation: 4 });
    const observed: number[] = [];
    const unsubscribe = queue.subscribe(() => observed.push(queue.getSnapshot().revision));

    expect(queue.getSnapshot()).toEqual({ revision: 0, current: null, pendingCount: 0, closed: false });
    expect(queue.enqueue(first)).toEqual({ kind: 'enqueued', revision: 1 });
    expect(queue.enqueue(second)).toEqual({ kind: 'enqueued', revision: 2 });

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
    queue.enqueue(first);
    queue.enqueue(second);

    const firstSnapshot = queue.getSnapshot();
    expect(
      queue.resolve({
        revision: firstSnapshot.revision,
        entry: firstSnapshot.current!,
        decision: { answer: 'y' },
      }),
    ).toEqual({ kind: 'resolved', entry: first, decision: { answer: 'y' } });
    expect(queue.getSnapshot()).toEqual({ revision: 3, current: second, pendingCount: 1, closed: false });

    expect(queue.resolve({ revision: firstSnapshot.revision, entry: first, decision: { answer: 'y' } })).toEqual({
      kind: 'stale',
      reason: 'revision_mismatch',
    });
  });

  it('rejects a stale identity without claiming the current approval', () => {
    const queue = new BackgroundSubagentApprovalQueue();
    const original = entry('call-a');
    queue.enqueue(original);
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
    queue.enqueue(first);
    queue.enqueue(second, { onRelease: released });
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
    queue.enqueue(first, { onRelease: firstReleased });
    queue.enqueue(second);
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
    queue.enqueue(first, { onRelease: firstReleased });
    queue.enqueue(second, { onRelease: secondReleased });

    queue.close();
    queue.close();

    expect(firstReleased).toHaveBeenCalledTimes(1);
    expect(firstReleased).toHaveBeenCalledWith(first, { kind: 'closed' });
    expect(secondReleased).toHaveBeenCalledTimes(1);
    expect(secondReleased).toHaveBeenCalledWith(second, { kind: 'closed' });
    expect(queue.getSnapshot()).toEqual({ revision: 3, current: null, pendingCount: 0, closed: true });
    expect(queue.enqueue(entry('late'))).toEqual({ kind: 'closed' });
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
      if (revision === 1) queue.enqueue(entry('call-b'));
    });

    queue.enqueue(entry('call-a'));

    expect(firstRevisions).toEqual([1]);
    expect(secondRevisions).toEqual([1, 2]);
  });
});
