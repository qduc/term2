import { describe, expect, it, vi } from 'vitest';
import type { PendingApproval } from '../../contracts/conversation.js';
import { NestedApprovalOwner } from './nested-approval-owner.js';

const approval = (callId: string): PendingApproval => ({
  agentName: 'Nested run_code',
  toolName: 'read_file',
  argumentsText: JSON.stringify({ path: '/workspace/file.txt' }),
  rawInterruption: null,
  callId,
});

const request = (
  owner: NestedApprovalOwner,
  callId: string,
  options: {
    revalidate?: () => Promise<'prompt' | 'auto_approve' | 'unknown'>;
    revalidateAuthority?: () => boolean | Promise<boolean>;
    grant?: () => void;
    dispatch?: () => Promise<string>;
    signal?: AbortSignal;
  } = {},
) => {
  const controller = options.signal ? undefined : new AbortController();
  const signal = options.signal ?? controller!.signal;
  const dispatch = options.dispatch ?? vi.fn(async () => callId);
  const grant = options.grant ?? vi.fn();
  const promise = owner.request({
    requestId: callId,
    sessionId: 'session-1',
    graphIdentity: {},
    outerRunId: 'run-1',
    nestedCallId: callId,
    toolName: 'read_file',
    preparedArguments: { path: '/workspace/file.txt' },
    authorityContext: {},
    approval: approval(callId),
    signal,
    revalidate: options.revalidate ?? (async () => 'prompt'),
    revalidateAuthority: options.revalidateAuthority,
    grant,
    dispatch,
  });
  return { promise, controller, dispatch, grant };
};

describe('NestedApprovalOwner', () => {
  it('displays one request and consumes an approval exactly once', async () => {
    const owner = new NestedApprovalOwner();
    const graph = {};
    owner.bindGraph(graph);
    const grant = vi.fn();
    const dispatch = vi.fn(async () => 'effect');
    const controller = new AbortController();
    const promise = owner.request({
      requestId: 'call-1',
      sessionId: 'session-1',
      graphIdentity: graph,
      outerRunId: 'run-1',
      nestedCallId: 'call-1',
      toolName: 'read_file',
      preparedArguments: { path: 'file' },
      authorityContext: {},
      approval: approval('call-1'),
      signal: controller.signal,
      revalidate: async () => 'prompt',
      grant,
      dispatch,
    });
    expect(owner.getSnapshot()?.requestId).toBe('call-1');
    await expect(owner.decide('call-1', { answer: 'y' })).resolves.toEqual({ kind: 'accepted' });
    await expect(promise).resolves.toEqual({ kind: 'approved', result: 'effect' });
    expect(grant).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    await expect(owner.decide('call-1', { answer: 'y' })).resolves.toEqual({ kind: 'stale' });
  });

  it('keeps a second call pending but only lets the displayed call decide', async () => {
    const owner = new NestedApprovalOwner();
    const first = request(owner, 'first');
    const second = request(owner, 'second');
    expect(owner.getSnapshot()?.requestId).toBe('first');
    await expect(owner.decide('second', { answer: 'y' })).resolves.toEqual({ kind: 'stale' });
    await owner.decide('first', { answer: 'n', rejectionReason: 'not now' });
    await expect(first.promise).resolves.toEqual({
      kind: 'denied',
      message: "Tool execution was not approved. User's reason: not now",
    });
    expect(owner.getSnapshot()?.requestId).toBe('second');
    await owner.decide('second', { answer: 'y' });
    await expect(second.promise).resolves.toMatchObject({ kind: 'approved' });
  });

  it('denies after policy failure or graph replacement without granting or dispatching', async () => {
    const owner = new NestedApprovalOwner();
    const graph = {};
    owner.bindGraph(graph);
    const grant = vi.fn();
    const dispatch = vi.fn(async () => 'effect');
    const controller = new AbortController();
    const promise = owner.request({
      requestId: 'call-1',
      sessionId: 'session-1',
      graphIdentity: graph,
      outerRunId: 'run-1',
      nestedCallId: 'call-1',
      toolName: 'read_file',
      preparedArguments: {},
      authorityContext: {},
      approval: approval('call-1'),
      signal: controller.signal,
      revalidate: async () => 'error',
      grant,
      dispatch,
    });
    await owner.decide('call-1', { answer: 'y' });
    await expect(promise).resolves.toMatchObject({ kind: 'denied' });
    expect(grant).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('invalidates consent when the graph changes while waiting', async () => {
    const owner = new NestedApprovalOwner();
    const graph = {};
    owner.bindGraph(graph);
    const prepared = { path: '/workspace/one.txt' };
    const controller = new AbortController();
    const grant = vi.fn();
    const dispatch = vi.fn(async () => 'effect');
    const promise = owner.request({
      requestId: 'call-1',
      sessionId: 'session-1',
      graphIdentity: graph,
      outerRunId: 'run-1',
      nestedCallId: 'call-1',
      toolName: 'read_file',
      preparedArguments: prepared,
      authorityContext: {},
      approval: approval('call-1'),
      signal: controller.signal,
      revalidate: async () => 'prompt',
      grant,
      dispatch,
    });
    owner.bindGraph({});
    await owner.decide('call-1', { answer: 'y' });
    await expect(promise).resolves.toMatchObject({ kind: 'denied' });
    expect(grant).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('invalidates consent when the prepared target changes while waiting', async () => {
    const owner = new NestedApprovalOwner();
    const graph = {};
    owner.bindGraph(graph);
    const prepared = { path: '/workspace/one.txt' };
    const grant = vi.fn();
    const dispatch = vi.fn(async () => 'effect');
    const promise = owner.request({
      requestId: 'call-1',
      sessionId: 'session-1',
      graphIdentity: graph,
      outerRunId: 'run-1',
      nestedCallId: 'call-1',
      toolName: 'read_file',
      preparedArguments: prepared,
      authorityContext: {},
      approval: approval('call-1'),
      signal: new AbortController().signal,
      revalidate: async () => 'prompt',
      grant,
      dispatch,
    });
    prepared.path = '/outside/two.txt';
    await owner.decide('call-1', { answer: 'y' });
    await expect(promise).resolves.toMatchObject({ kind: 'denied' });
    expect(grant).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('cancels waiters and ignores a late approval', async () => {
    const owner = new NestedApprovalOwner();
    const waiting = request(owner, 'call-1');
    owner.close();
    await expect(waiting.promise).resolves.toMatchObject({ kind: 'denied' });
    await expect(owner.decide('call-1', { answer: 'y' })).resolves.toEqual({ kind: 'stale' });
    expect(waiting.grant).not.toHaveBeenCalled();
    expect(waiting.dispatch).not.toHaveBeenCalled();
  });

  it('does not grant when cancellation wins while revalidation is pending', async () => {
    const owner = new NestedApprovalOwner();
    const controller = new AbortController();
    let release!: (value: 'prompt') => void;
    const revalidate = () =>
      new Promise<'prompt'>((resolve) => {
        release = resolve;
      });
    const waiting = request(owner, 'call-1', { signal: controller.signal, revalidate });
    await owner.decide('call-1', { answer: 'y' });
    controller.abort();
    release('prompt');
    await expect(waiting.promise).resolves.toMatchObject({ kind: 'denied' });
    expect(waiting.grant).not.toHaveBeenCalled();
    expect(waiting.dispatch).not.toHaveBeenCalled();
  });

  it('keeps an approved dispatch settled when cancellation arrives after dispatch starts', async () => {
    const owner = new NestedApprovalOwner();
    const controller = new AbortController();
    let release!: (value: string) => void;
    const dispatch = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const waiting = request(owner, 'call-1', { signal: controller.signal, dispatch });
    await owner.decide('call-1', { answer: 'y' });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    controller.abort();
    release('effect');
    await expect(waiting.promise).resolves.toEqual({ kind: 'approved', result: 'effect' });
  });

  it('denies when the prepared authority meaning changes while waiting', async () => {
    const owner = new NestedApprovalOwner();
    let authorityValid = true;
    const waiting = request(owner, 'call-1', { revalidateAuthority: () => authorityValid });
    authorityValid = false;
    await owner.decide('call-1', { answer: 'y' });
    await expect(waiting.promise).resolves.toMatchObject({ kind: 'denied' });
    expect(waiting.grant).not.toHaveBeenCalled();
    expect(waiting.dispatch).not.toHaveBeenCalled();
  });

  it('settles an approved dispatch failure as a failure, not a denial', async () => {
    const owner = new NestedApprovalOwner();
    const waiting = request(owner, 'call-1', {
      dispatch: async () => {
        throw new Error('after effect');
      },
    });
    await owner.decide('call-1', { answer: 'y' });
    await expect(waiting.promise).resolves.toMatchObject({ kind: 'failed', error: expect.any(Error) });
  });

  it('does not publish an observer before an approved grant and dispatch commit', async () => {
    const owner = new NestedApprovalOwner();
    const events: string[] = [];
    owner.subscribe((snapshot) => {
      if (snapshot === null) {
        events.push('published-null');
        throw new Error('observer failed');
      }
    });
    events.length = 0;
    const waiting = request(owner, 'call-1', {
      grant: () => events.push('grant'),
      dispatch: async () => {
        events.push('dispatch');
        return 'effect';
      },
    });
    await owner.decide('call-1', { answer: 'y' });
    await expect(waiting.promise).resolves.toMatchObject({ kind: 'approved' });
    expect(events).toEqual(['grant', 'dispatch', 'published-null']);
  });

  it('publishes the next request when an approved dispatch starts', async () => {
    const owner = new NestedApprovalOwner();
    const snapshots: Array<string | null> = [];
    owner.subscribe((snapshot) => snapshots.push(snapshot?.requestId ?? null));
    let releaseFirst!: (value: string) => void;
    const first = request(owner, 'first', {
      dispatch: () =>
        new Promise<string>((resolve) => {
          releaseFirst = resolve;
        }),
    });
    const second = request(owner, 'second');

    await owner.decide('first', { answer: 'y' });
    await vi.waitFor(() => expect(owner.getSnapshot()?.requestId).toBe('second'));
    expect(snapshots).toEqual([null, 'first', 'first', 'second']);
    await owner.decide('second', { answer: 'n' });
    releaseFirst('effect');
    await expect(first.promise).resolves.toMatchObject({ kind: 'approved' });
    await expect(second.promise).resolves.toMatchObject({ kind: 'denied' });
  });
});
