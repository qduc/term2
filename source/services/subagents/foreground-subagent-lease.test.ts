import { describe, expect, it } from 'vitest';
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

  it('resumes the retained continuation once with a generation-checked approval', async () => {
    const lease = new ForegroundSubagentLease({ runId: 'child' });
    lease.adopt();
    const approved: unknown[] = [];
    const handle = createContinuationHandle({ approve: (item: unknown) => approved.push(item) });
    const interruption = { callId: 'call-1' };
    const waiting = lease.waitForBackgroundApproval(handle, interruption);
    const pending = lease.getPendingApproval()!;
    expect(lease.resolveBackgroundApproval(pending.generation + 1, { kind: 'approve' })).toBe(false);
    expect(lease.resolveBackgroundApproval(pending.generation, { kind: 'approve' })).toBe(true);
    expect(await waiting).toBe(true);
    expect(approved).toEqual([interruption]);
    expect(lease.resolveBackgroundApproval(pending.generation, { kind: 'approve' })).toBe(false);
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
    lease.resolveBackgroundApproval(pending.generation, { kind: 'reject', message: 'not now' });
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
    expect(lease.resolveBackgroundApproval(pending.generation, { kind: 'approve' })).toBe(false);
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
    expect(lease.resolveBackgroundApproval(firstPending.generation, { kind: 'approve' })).toBe(true);
    await first;
    const second = lease.waitForBackgroundApproval(handle, { callId: 'two' });
    const secondPending = lease.getPendingApproval()!;
    expect(secondPending.generation).toBeGreaterThan(firstPending.generation);
    expect(lease.resolveBackgroundApproval(firstPending.generation, { kind: 'approve' })).toBe(false);
    expect(lease.resolveBackgroundApproval(secondPending.generation, { kind: 'approve' })).toBe(true);
    await second;
    expect(approved).toEqual([{ callId: 'one' }, { callId: 'two' }]);
  });
});
