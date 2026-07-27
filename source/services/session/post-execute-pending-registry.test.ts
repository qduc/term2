import { describe, expect, it } from 'vitest';
import { PostExecutePendingRegistry, type PostExecuteDecision } from './post-execute-pending-registry.js';

const entry = (callId: string, runId = 'run-1') => ({
  runId,
  toolCallId: callId,
  toolName: 'shell',
  argumentsText: `{\"command\":\"${callId}\"}`,
});

describe('PostExecutePendingRegistry', () => {
  it('publishes an authoritative revisioned snapshot and settles its selected entries once', async () => {
    const registry = new PostExecutePendingRegistry({ sessionId: 'session-a', epoch: 4 });
    const first = registry.register(entry('call-a'));
    const second = registry.register(entry('call-b'));

    const snapshot = registry.snapshot();
    expect(snapshot).toMatchObject({ revision: 2, sessionId: 'session-a', epoch: 4 });
    expect(snapshot.entries.map((item) => item.id)).toEqual(['session-a:4:run-1:call-a', 'session-a:4:run-1:call-b']);

    expect(
      registry.decide({ revision: snapshot.revision, ids: [snapshot.entries[0].id], decision: 'approve' }),
    ).toEqual({
      kind: 'settled',
      settledIds: [snapshot.entries[0].id],
    });
    await expect(first).resolves.toBe('approve');
    expect(registry.snapshot().entries).toHaveLength(1);
    expect(
      registry.decide({ revision: snapshot.revision, ids: [snapshot.entries[0].id], decision: 'approve' }),
    ).toEqual({
      kind: 'invalid',
      reason: 'revision_mismatch',
    });
    await registry.decide({
      revision: registry.snapshot().revision,
      ids: [registry.snapshot().entries[0].id],
      decision: 'reject',
    });
    await expect(second).resolves.toBe('reject');
  });

  it('validates selective decisions atomically and exposes a level-triggered version latch', async () => {
    const registry = new PostExecutePendingRegistry({ sessionId: 'session-a', epoch: 1 });
    const version = registry.version;
    const wake = registry.waitForChange(version);
    const first = registry.register(entry('call-a'));
    const second = registry.register(entry('call-b'));
    await expect(wake).resolves.toBeGreaterThan(version);

    const snapshot = registry.snapshot();
    expect(
      registry.decide({ revision: snapshot.revision, ids: [snapshot.entries[0].id, 'missing'], decision: 'approve' }),
    ).toEqual({
      kind: 'invalid',
      reason: 'unknown_entry',
    });
    expect(registry.snapshot().entries).toHaveLength(2);

    registry.close();
    await expect(first).resolves.toBe('reject');
    await expect(second).resolves.toBe('reject');
    expect(() => registry.register(entry('late'))).toThrow('closed');
  });

  it('rejects stale and duplicate decisions without changing pending entries', () => {
    const registry = new PostExecutePendingRegistry({ sessionId: 'session-a', epoch: 1 });
    registry.register(entry('call-a'));
    const snapshot = registry.snapshot();
    const request = {
      revision: snapshot.revision,
      ids: [snapshot.entries[0].id],
      decision: 'approve' as PostExecuteDecision,
    };

    expect(registry.decide({ ...request, revision: 0 })).toEqual({ kind: 'invalid', reason: 'revision_mismatch' });
    expect(registry.decide(request)).toEqual({ kind: 'settled', settledIds: request.ids });
    expect(registry.decide(request)).toEqual({ kind: 'invalid', reason: 'revision_mismatch' });
  });
});
