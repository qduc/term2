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

  it('uses the rejection resolver to discard call state outside an owned foreground run', async () => {
    const pending = new PostExecutePendingRegistry({ sessionId: 'session-a', epoch: 1 });
    const resolve = vi.fn(({ result }) => result);
    const policy = createPostExecutePausePolicy({
      pending,
      runId: null,
      describe: () => ({ toolName: 'shell', argumentsText: '{}' }),
      resolve,
    });

    await expect(
      policy({ params: {}, result: 'original', details: { toolCall: { callId: 'call-a' } }, executeAgain: vi.fn() }),
    ).resolves.toBe('original');
    expect(resolve).toHaveBeenCalledWith(expect.anything(), 'reject');
    expect(pending.snapshot().entries).toEqual([]);
  });

  it('keeps concurrent identical command decisions isolated by call ID', async () => {
    const pending = new PostExecutePendingRegistry({ sessionId: 'session-a', epoch: 1 });
    const overrides = new Map<string, string>();
    const policy = createPostExecutePausePolicy({
      pending,
      runId: 'run-1',
      describe: (_params, _result, details) => ({
        toolName: 'shell',
        argumentsText: '{"command":"cat private"}',
        deniedRead: {
          deniedPath: `/private/${(details as any).toolCall.callId}`,
          suggestedParent: `/private/${(details as any).toolCall.callId}`,
          sensitive: false,
          command: 'cat private',
        },
      }),
      resolve: ({ details, result, executeAgain }, decision) => {
        const callId = (details as any).toolCall.callId;
        if (decision !== 'allow-once') return result;
        overrides.set(callId, `override:${callId}`);
        return executeAgain();
      },
    });
    const retryA = vi.fn(async () => overrides.get('call-a'));
    const retryB = vi.fn(async () => overrides.get('call-b'));
    const blockedA = policy({
      params: {},
      result: 'denied-a',
      details: { toolCall: { callId: 'call-a' } },
      executeAgain: retryA,
    });
    const blockedB = policy({
      params: {},
      result: 'denied-b',
      details: { toolCall: { callId: 'call-b' } },
      executeAgain: retryB,
    });
    await Promise.resolve();
    const snapshot = pending.snapshot();
    expect(snapshot.entries.map((entry) => entry.deniedRead?.deniedPath)).toEqual([
      '/private/call-a',
      '/private/call-b',
    ]);
    pending.decide({ revision: snapshot.revision, ids: [snapshot.entries[1]!.id], decision: 'reject' });
    await expect(blockedB).resolves.toBe('denied-b');
    expect(retryA).not.toHaveBeenCalled();
    const afterB = pending.snapshot();
    pending.decide({ revision: afterB.revision, ids: [afterB.entries[0]!.id], decision: 'allow-once' });
    await expect(blockedA).resolves.toBe('override:call-a');
    expect(retryB).not.toHaveBeenCalled();
  });
});
