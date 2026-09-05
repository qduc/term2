import { describe, expect, it, vi } from 'vitest';
import type { NestedApprovalSnapshot } from '../../source/services/approval/nested-approval-owner.js';
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
  const decisions: { requestId: string; answer: string; rejectionReason?: string }[] = [];
  const port: NestedApprovalDecisionPort = {
    getSnapshot: () => snapshot,
    subscribe: (next) => {
      observer = next;
      next?.(snapshot);
      return () => {
        if (observer === next) observer = null;
      };
    },
    decide: async (requestId, decision) => {
      decisions.push({ requestId, ...decision });
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
    adapter.dispose();
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
    adapter.dispose();
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
    adapter.dispose();
  });

  it('denies a pending request when disposed', async () => {
    let observer: ((snapshot: NestedApprovalSnapshot | null) => void) | null = null;
    const decisions: string[] = [];
    const snapshot = baseSnapshot();
    const port: NestedApprovalDecisionPort = {
      getSnapshot: () => snapshot,
      subscribe: (next) => {
        observer = next;
        return () => {
          observer = null;
        };
      },
      decide: async (_requestId, decision) => {
        decisions.push(decision.answer);
        return { kind: 'accepted' };
      },
    };
    const adapter = createScriptedNestedApprovalAdapter(port, []);

    adapter.dispose();
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
    adapter.dispose();
    resolveResponder({ answer: 'allow-edit-file-session' });
    await flush();

    expect(decisions.every((answer) => answer === 'n')).toBe(true);
  });
});
