import { describe, expect, it, vi } from 'vitest';
import {
  NestedApprovalOwner,
  type NestedApprovalSnapshot,
} from '../../source/services/approval/nested-approval-owner.js';
import { createScriptedNestedApprovalAdapter, type NestedApprovalDecisionPort } from './scripted-decision-adapter.js';

const baseSnapshot = (): NestedApprovalSnapshot => ({
  requestId: 'request-1',
  sessionId: 'session-1',
  outerRunId: 'outer-1',
  nestedCallId: 'outer-1:call-1',
  toolName: 'create_file',
  preparedArguments: { path: '/tmp/file', content: 'content', overwrite: false },
  authorityContext: null,
  approval: {
    agentName: 'Nested run_code',
    toolName: 'create_file',
    argumentsText: '{}',
    rawInterruption: null,
    callId: 'outer-1:call-1',
  },
});

function makePort(snapshot: NestedApprovalSnapshot, result: 'accepted' | 'stale' = 'accepted') {
  let observer: ((next: NestedApprovalSnapshot | null) => void) | null = null;
  let currentSnapshot: NestedApprovalSnapshot | null = snapshot;
  const decisions: { requestId: string; answer: string; rejectionReason?: string }[] = [];
  const port: NestedApprovalDecisionPort = {
    getSnapshot: () => currentSnapshot,
    subscribe: (next) => {
      observer = next;
      next?.(snapshot);
      return () => {
        if (observer === next) observer = null;
      };
    },
    decide: async (requestId, decision) => {
      decisions.push({ requestId, ...decision });
      currentSnapshot = null;
      observer?.(null);
      return { kind: result };
    },
  };
  return { port, decisions };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function realRequest(
  id: string,
  options: {
    revalidate?: () => Promise<'prompt' | 'auto_approve'>;
    dispatch?: () => Promise<string>;
  } = {},
) {
  const controller = new AbortController();
  return {
    requestId: id,
    sessionId: 'session-1',
    graphIdentity: {},
    outerRunId: 'outer-1',
    nestedCallId: 'outer-1:' + id,
    toolName: 'create_file',
    preparedArguments: { path: '/tmp/' + id, content: id, overwrite: false },
    authorityContext: null,
    approval: {
      agentName: 'Nested run_code',
      toolName: 'create_file',
      argumentsText: '{}',
      rawInterruption: null,
      callId: 'outer-1:' + id,
    },
    signal: controller.signal,
    revalidate: options.revalidate ?? (async () => 'prompt' as const),
    grant: () => {},
    dispatch: options.dispatch ?? (async () => id),
  };
}

describe('scripted nested approval adapter', () => {
  it.each([
    ['an unmatched request', (snapshot: NestedApprovalSnapshot) => ({ ...snapshot, toolName: 'other_tool' })],
    [
      'a non-tool approval descriptor',
      (snapshot: NestedApprovalSnapshot) => ({
        ...snapshot,
        approval: { ...snapshot.approval, checkIn: 'max_turns' as const },
      }),
    ],
  ])('denies %s without invoking the authority policy', async (_label, mutate) => {
    const snapshot = mutate(baseSnapshot());
    const { port, decisions } = makePort(snapshot);
    const adapter = createScriptedNestedApprovalAdapter(port, [
      {
        sessionId: 'session-1',
        toolName: 'create_file',
        preparedArguments: baseSnapshot().preparedArguments,
        answer: 'allow-edit-file-session',
      },
    ]);

    await flush();
    expect(decisions).toEqual([
      { requestId: 'request-1', answer: 'n', rejectionReason: 'Scripted nested approval denied.' },
    ]);
    await adapter.dispose();
  });

  it('denies when the responder fails', async () => {
    const { port, decisions } = makePort(baseSnapshot());
    const adapter = createScriptedNestedApprovalAdapter(
      port,
      [
        {
          sessionId: 'session-1',
          toolName: 'create_file',
          preparedArguments: baseSnapshot().preparedArguments,
          answer: 'allow-edit-file-session',
        },
      ],
      { responder: () => Promise.reject(new Error('responder failed')) },
    );

    await flush();
    expect(decisions[0]?.answer).toBe('n');
    await adapter.dispose();
  });

  it('does not grant a stale answer and disposes its subscription', async () => {
    const { port, decisions } = makePort(baseSnapshot(), 'stale');
    const onRequest = vi.fn();
    const adapter = createScriptedNestedApprovalAdapter(
      port,
      [
        {
          sessionId: 'session-1',
          toolName: 'create_file',
          preparedArguments: baseSnapshot().preparedArguments,
          answer: 'allow-edit-file-session',
        },
      ],
      { onRequest },
    );

    await flush();
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(decisions[0]?.answer).toBe('allow-edit-file-session');
    await adapter.dispose();
  });

  it('denies a pending request when disposed', async () => {
    let observer: ((snapshot: NestedApprovalSnapshot | null) => void) | null = null;
    const decisions: string[] = [];
    const snapshot = baseSnapshot();
    let currentSnapshot: NestedApprovalSnapshot | null = snapshot;
    const port: NestedApprovalDecisionPort = {
      getSnapshot: () => currentSnapshot,
      subscribe: (next) => {
        observer = next;
        return () => {
          observer = null;
        };
      },
      decide: async (_requestId, decision) => {
        decisions.push(decision.answer);
        currentSnapshot = null;
        observer?.(null);
        return { kind: 'accepted' };
      },
    };
    const adapter = createScriptedNestedApprovalAdapter(port, []);

    await adapter.dispose();
    expect(decisions).toEqual(['n']);
    expect(observer).toBeNull();
  });

  it('turns a responder that resolves after disposal into a denial', async () => {
    let resolveResponder!: (decision: { answer: string }) => void;
    let snapshot: NestedApprovalSnapshot | null = baseSnapshot();
    const decisions: string[] = [];
    const port: NestedApprovalDecisionPort = {
      getSnapshot: () => snapshot,
      subscribe: (next) => {
        next?.(snapshot);
        return () => {};
      },
      decide: async (_requestId, decision) => {
        decisions.push(decision.answer);
        snapshot = null;
        return { kind: 'accepted' };
      },
    };
    const adapter = createScriptedNestedApprovalAdapter(
      port,
      [
        {
          sessionId: 'session-1',
          toolName: 'create_file',
          preparedArguments: baseSnapshot().preparedArguments,
          answer: 'allow-edit-file-session',
        },
      ],
      { responder: () => new Promise((resolve) => (resolveResponder = resolve)) },
    );

    await Promise.resolve();
    await adapter.dispose();
    resolveResponder({ answer: 'allow-edit-file-session' });
    await flush();

    expect(decisions.every((answer) => answer === 'n')).toBe(true);
  });

  it('answers a queued real-owner request after denying the displayed request', async () => {
    const owner = new NestedApprovalOwner('session-1');
    const a = owner.request(realRequest('a'));
    const b = owner.request(realRequest('b'));
    const seen: string[] = [];
    const adapter = createScriptedNestedApprovalAdapter(
      owner,
      [
        {
          sessionId: 'session-1',
          toolName: 'create_file',
          preparedArguments: { path: '/tmp/a', content: 'a', overwrite: false },
          answer: 'n',
        },
        {
          sessionId: 'session-1',
          toolName: 'create_file',
          preparedArguments: { path: '/tmp/b', content: 'b', overwrite: false },
          answer: 'y',
        },
      ],
      { onRequest: (snapshot) => seen.push(snapshot.requestId) },
    );

    await expect(Promise.all([a, b])).resolves.toEqual([
      { kind: 'denied', message: 'Tool execution was not approved.' },
      { kind: 'approved', result: 'b' },
    ]);
    expect(seen).toEqual(['a', 'b']);
    await adapter.dispose();
  });

  it('does not re-answer the deciding real-owner head before answering the queued next request', async () => {
    const owner = new NestedApprovalOwner('session-1');
    let releaseRevalidation!: () => void;
    const revalidation = new Promise<'prompt' | 'auto_approve'>((resolve) => {
      releaseRevalidation = () => resolve('prompt');
    });
    const effects: string[] = [];
    const a = owner.request(
      realRequest('a', {
        revalidate: async () => revalidation,
        dispatch: async () => {
          effects.push('a');
          return 'a';
        },
      }),
    );
    const b = owner.request(
      realRequest('b', {
        dispatch: async () => {
          effects.push('b');
          return 'b';
        },
      }),
    );
    const decisions: string[] = [];
    const adapter = createScriptedNestedApprovalAdapter(
      owner,
      [
        {
          sessionId: 'session-1',
          toolName: 'create_file',
          preparedArguments: { path: '/tmp/a', content: 'a', overwrite: false },
          answer: 'y',
        },
        {
          sessionId: 'session-1',
          toolName: 'create_file',
          preparedArguments: { path: '/tmp/b', content: 'b', overwrite: false },
          answer: 'y',
        },
      ],
      { onRequest: (snapshot) => decisions.push(snapshot.requestId) },
    );

    await flush();
    releaseRevalidation();
    await expect(Promise.all([a, b])).resolves.toEqual([
      { kind: 'approved', result: 'a' },
      { kind: 'approved', result: 'b' },
    ]);
    expect(decisions).toEqual(['a', 'b']);
    expect(effects).toEqual(['a', 'b']);
    await adapter.dispose();
  });

  it('denies every queued real-owner request before detaching on disposal', async () => {
    const owner = new NestedApprovalOwner('session-1');
    let releaseResponder!: () => void;
    const responder = new Promise<never>((resolve) => {
      releaseResponder = () => resolve();
    });
    const a = owner.request(realRequest('a'));
    const b = owner.request(realRequest('b'));
    const adapter = createScriptedNestedApprovalAdapter(
      owner,
      [
        {
          sessionId: 'session-1',
          toolName: 'create_file',
          preparedArguments: { path: '/tmp/a', content: 'a', overwrite: false },
          answer: 'y',
        },
      ],
      { responder: async () => responder },
    );

    const disposal = adapter.dispose();
    await expect(disposal).resolves.toBeUndefined();
    await expect(Promise.all([a, b])).resolves.toEqual([
      { kind: 'denied', message: "Tool execution was not approved. User's reason: Scripted nested approval denied." },
      { kind: 'denied', message: "Tool execution was not approved. User's reason: Scripted nested approval denied." },
    ]);
    expect(owner.getSnapshot()).toBeNull();
    releaseResponder();
  });

  it('retries the queued head after disposal waits for an already-deciding allow', async () => {
    const owner = new NestedApprovalOwner('session-1');
    let releaseRevalidation!: () => void;
    const revalidation = new Promise<'prompt' | 'auto_approve'>((resolve) => {
      releaseRevalidation = () => resolve('prompt');
    });
    const a = owner.request(realRequest('a', { revalidate: async () => revalidation }));
    const b = owner.request(realRequest('b'));
    const adapter = createScriptedNestedApprovalAdapter(owner, [
      {
        sessionId: 'session-1',
        toolName: 'create_file',
        preparedArguments: { path: '/tmp/a', content: 'a', overwrite: false },
        answer: 'y',
      },
      {
        sessionId: 'session-1',
        toolName: 'create_file',
        preparedArguments: { path: '/tmp/b', content: 'b', overwrite: false },
        answer: 'y',
      },
    ]);

    await flush();
    const disposal = adapter.dispose();
    releaseRevalidation();

    await expect(disposal).resolves.toBeUndefined();
    await expect(Promise.all([a, b])).resolves.toEqual([
      { kind: 'approved', result: 'a' },
      { kind: 'denied', message: "Tool execution was not approved. User's reason: Scripted nested approval denied." },
    ]);
  });
});
