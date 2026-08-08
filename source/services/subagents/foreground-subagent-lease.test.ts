import { describe, expect, it, vi } from 'vitest';
import { createContinuationHandle } from '../../contracts/continuation-handle.js';
import { ForegroundSubagentLease } from './foreground-subagent-lease.js';

describe('ForegroundSubagentLease', () => {
  it('forwards parent abort before adoption and detaches it after adoption', () => {
    const parent = new AbortController();
    const before = new ForegroundSubagentLease({ runId: 'before', parentSignal: parent.signal });
    parent.abort();
    expect(before.signal.aborted).toBe(true);

    const laterParent = new AbortController();
    const after = new ForegroundSubagentLease({ runId: 'after', parentSignal: laterParent.signal });
    after.adopt();
    laterParent.abort();
    expect(after.signal.aborted).toBe(false);
    after.cancel();
    expect(after.signal.aborted).toBe(true);
  });

  it('exposes the exact retained continuation only to a generation-and-identity checked application callback', async () => {
    const lease = new ForegroundSubagentLease({ runId: 'child' });
    lease.adopt();
    const approved: unknown[] = [];
    const handle = createContinuationHandle({ approve: (item: unknown) => approved.push(item) });
    const interruption = { callId: 'call-1' };
    const waiting = lease.waitForBackgroundApproval(handle, interruption);
    const pending = lease.getPendingApproval()!;
    expect(
      lease.applyBackgroundApproval({ ...pending, generation: pending.generation + 1 }, ({ handle, interruption }) => {
        handle.approve?.(interruption);
        return true;
      }),
    ).toBe(false);
    expect(
      lease.applyBackgroundApproval({ ...pending, interruption: { callId: 'call-1' } }, ({ handle, interruption }) => {
        handle.approve?.(interruption);
        return true;
      }),
    ).toBe(false);
    expect(
      lease.applyBackgroundApproval(pending, ({ handle, interruption: exactInterruption }) => {
        handle.approve?.(exactInterruption);
        return true;
      }),
    ).toBe(true);
    expect(await waiting).toBe(true);
    expect(approved).toEqual([interruption]);
    expect(lease.applyBackgroundApproval(pending, () => true)).toBe(false);
  });

  it('applies rejection messages only through the retained continuation', async () => {
    const lease = new ForegroundSubagentLease({ runId: 'child' });
    lease.adopt();
    const rejected: Array<{ item: unknown; message?: string }> = [];
    const handle = createContinuationHandle({
      reject: (item: unknown, options?: { message?: string }) => rejected.push({ item, message: options?.message }),
    });
    const interruption = { callId: 'call-2' };
    const waiting = lease.waitForBackgroundApproval(handle, interruption);
    const pending = lease.getPendingApproval()!;
    lease.applyBackgroundApproval(pending, ({ handle: exactHandle, interruption: exactInterruption }) => {
      exactHandle.reject?.(exactInterruption, { message: 'not now' });
      return true;
    });
    await waiting;
    expect(rejected).toEqual([{ item: interruption, message: 'not now' }]);
  });

  it('unblocks a pending approval when cancelled', async () => {
    const lease = new ForegroundSubagentLease({ runId: 'child' });
    lease.adopt();
    const waiting = lease.waitForBackgroundApproval(createContinuationHandle({}), { callId: 'call-3' });
    lease.cancel();
    await expect(waiting).resolves.toBe(false);
    expect(lease.getPendingApproval()).toBeUndefined();
  });

  it('unblocks a pending approval when settled', async () => {
    const lease = new ForegroundSubagentLease({ runId: 'child' });
    lease.adopt();
    const waiting = lease.waitForBackgroundApproval(createContinuationHandle({}), { callId: 'call-4' });
    lease.settle();
    await expect(waiting).resolves.toBe(false);
    expect(lease.getPendingApproval()).toBeUndefined();
  });

  it('makes adoption one-shot and fails closed when continuation capabilities are absent', async () => {
    const lease = new ForegroundSubagentLease({ runId: 'child' });
    lease.adopt();
    expect(() => lease.adopt()).toThrow(/already adopted/);
    const waiting = lease.waitForBackgroundApproval(createContinuationHandle({}), { callId: 'call-5' });
    const pending = lease.getPendingApproval()!;
    expect(lease.applyBackgroundApproval(pending, () => true)).toBe(true);
    lease.cancel();
    await expect(waiting).resolves.toBe(false);
  });

  it('allocates a fresh interaction generation for repeated approvals', async () => {
    const lease = new ForegroundSubagentLease({ runId: 'child' });
    lease.adopt();
    const approved: unknown[] = [];
    const handle = createContinuationHandle({ approve: (item: unknown) => approved.push(item) });
    const first = lease.waitForBackgroundApproval(handle, { callId: 'one' });
    const firstPending = lease.getPendingApproval()!;
    expect(
      lease.applyBackgroundApproval(firstPending, ({ handle, interruption }) => {
        handle.approve?.(interruption);
        return true;
      }),
    ).toBe(true);
    await first;
    const second = lease.waitForBackgroundApproval(handle, { callId: 'two' });
    const secondPending = lease.getPendingApproval()!;
    expect(secondPending.generation).toBeGreaterThan(firstPending.generation);
    expect(lease.applyBackgroundApproval(firstPending, () => true)).toBe(false);
    expect(
      lease.applyBackgroundApproval(secondPending, ({ handle, interruption }) => {
        handle.approve?.(interruption);
        return true;
      }),
    ).toBe(true);
    await second;
    expect(approved).toEqual([{ callId: 'one' }, { callId: 'two' }]);
  });

  it('pairs each raw decision with the exact retained continuation closure', async () => {
    const lease = new ForegroundSubagentLease({ runId: 'child' });
    lease.adopt();
    const approved: unknown[] = [];
    const resumed: string[] = [];
    const handle = createContinuationHandle({ approve: (item: unknown) => approved.push(item) });
    const waiting = lease.waitForBackgroundContinuation(handle, { callId: 'one' }, () => resumed.push('exact-loop'));
    const pending = lease.getPendingApproval()!;
    expect(
      lease.applyBackgroundApproval(pending, ({ handle, interruption }) => {
        handle.approve?.(interruption);
        return true;
      }),
    ).toBe(true);
    await expect(waiting).resolves.toBe(true);
    expect(approved).toEqual([{ callId: 'one' }]);
    expect(resumed).toEqual(['exact-loop']);
  });

  it('does not resume or release the pause when policy application throws', async () => {
    const lease = new ForegroundSubagentLease({ runId: 'child' });
    lease.adopt();
    const resumed = vi.fn();
    const waiting = lease.waitForBackgroundContinuation(createContinuationHandle({}), { callId: 'one' }, resumed);
    const pending = lease.getPendingApproval()!;

    expect(() =>
      lease.applyBackgroundApproval(pending, () => {
        throw new Error('policy failed');
      }),
    ).toThrow('policy failed');
    expect(lease.getPendingApproval()).toEqual(pending);
    expect(resumed).not.toHaveBeenCalled();

    lease.cancel();
    await expect(waiting).resolves.toBe(false);
  });

  it('keeps a pause pending when policy declines to apply it', async () => {
    const lease = new ForegroundSubagentLease({ runId: 'child' });
    lease.adopt();
    const waiting = lease.waitForBackgroundApproval(createContinuationHandle({}), { callId: 'one' });
    const pending = lease.getPendingApproval()!;

    expect(lease.applyBackgroundApproval(pending, () => false)).toBe(false);
    expect(lease.getPendingApproval()).toEqual(pending);

    lease.cancel();
    await expect(waiting).resolves.toBe(false);
  });

  it('consumes a policy-applied pause when resuming the retained loop throws', async () => {
    const lease = new ForegroundSubagentLease({ runId: 'child' });
    lease.adopt();
    const waiting = lease.waitForBackgroundContinuation(
      createContinuationHandle({ approve: () => {} }),
      { callId: 'one' },
      () => {
        throw new Error('continuation launch failed');
      },
    );
    const pending = lease.getPendingApproval()!;

    expect(
      lease.applyBackgroundApproval(pending, ({ handle, interruption }) => {
        handle.approve?.(interruption);
        return true;
      }),
    ).toBe(true);
    expect(lease.getPendingApproval()).toBeUndefined();
    await expect(waiting).rejects.toThrow('continuation launch failed');
  });
});
