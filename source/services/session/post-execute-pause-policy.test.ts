import { describe, expect, it, vi } from 'vitest';
import { createPostExecutePausePolicy } from './post-execute-pause-policy.js';
import { PostExecutePendingRegistry } from './post-execute-pending-registry.js';

describe('createPostExecutePausePolicy', () => {
  it('holds one live tool execution and re-executes it only after its selected approval', async () => {
    const pending = new PostExecutePendingRegistry({ sessionId: 'session-a', epoch: 1 });
    const executeAgain = vi.fn(async () => 'retried');
    const policy = createPostExecutePausePolicy({
      pending,
      runId: 'run-1',
      describe: () => ({ toolName: 'shell', argumentsText: '{"command":"pwd"}' }),
    });

    const blocked = policy({
      params: {},
      result: 'original',
      details: { toolCall: { callId: 'call-a' } },
      executeAgain,
    });
    await Promise.resolve();
    const snapshot = pending.snapshot();
    expect(executeAgain).not.toHaveBeenCalled();
    expect(pending.decide({ revision: snapshot.revision, ids: [snapshot.entries[0].id], decision: 'approve' })).toEqual(
      {
        kind: 'settled',
        settledIds: [snapshot.entries[0].id],
      },
    );
    await expect(blocked).resolves.toBe('retried');
    expect(executeAgain).toHaveBeenCalledTimes(1);
  });

  it('fails closed without re-executing when the session closes', async () => {
    const pending = new PostExecutePendingRegistry({ sessionId: 'session-a', epoch: 1 });
    const executeAgain = vi.fn();
    const policy = createPostExecutePausePolicy({
      pending,
      runId: 'run-1',
      describe: () => ({ toolName: 'shell', argumentsText: '{}' }),
    });
    const blocked = policy({
      params: {},
      result: 'original',
      details: { toolCall: { callId: 'call-a' } },
      executeAgain,
    });

    await Promise.resolve();
    pending.close();
    await expect(blocked).resolves.toBe('original');
    expect(executeAgain).not.toHaveBeenCalled();
  });

  it('fails closed without creating a shared synthetic entry when the SDK omits the call ID', async () => {
    const pending = new PostExecutePendingRegistry({ sessionId: 'session-a', epoch: 1 });
    const executeAgain = vi.fn();
    const policy = createPostExecutePausePolicy({
      pending,
      runId: 'run-1',
      describe: () => ({ toolName: 'shell', argumentsText: '{}' }),
    });

    await expect(policy({ params: {}, result: 'original', details: {}, executeAgain })).rejects.toThrow(
      'requires an SDK tool call ID',
    );
    expect(pending.snapshot().entries).toEqual([]);
    expect(executeAgain).not.toHaveBeenCalled();
  });
});
