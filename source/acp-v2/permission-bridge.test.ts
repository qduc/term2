import { mkdtempSync, rmSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { createAcpV2SessionBackend } from './session-backend.js';

/**
 * Unit coverage for the ACP permission bridge.
 *
 * The harness models the two halves the bridge mediates: the session's pending
 * interaction snapshot (what term2 is asking the user about) and the ACP
 * client's `request()` (what the editor user answered). Denial cases assert both
 * the answer handed back to the runtime and that the tool side effect never
 * happened, so a fail-closed path cannot be confused with "the bridge never
 * ran": `applied` records every answer that reached the runtime, and `grants`
 * stands in for the session-scoped grant term2 applies for a `*-session`
 * answer.
 *
 * Session grants themselves live outside this bridge
 * (`source/services/approval/approval-grant-executor.ts` and
 * `source/services/approval/approval-flow-coordinator.ts`); the fake only
 * records which answer the bridge passed through.
 */

type Approval = Record<string, unknown>;

type HarnessOptions = {
  respond: (params: any, requestOptions: any) => unknown;
  decideApproval?: (request: any, context: any) => Promise<{ answer: string; reason?: string }>;
  withClient?: boolean;
};

const noopWriterFactory = () => ({
  init: () => {},
  append: () => {},
  rotate: () => {},
  flush: async () => {},
  close: async () => {},
});

const deferred = () => {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const createHarness = (options: HarnessOptions) => {
  const applied: Array<{ answer: string; rejectionReason?: string }> = [];
  const grants = new Set<string>();
  const requests: Array<{ method: string; params: any; options: any }> = [];
  const updates: any[] = [];
  let snapshot: {
    interactionId: number;
    revision: number;
    approval: Approval;
    askUserAnswers: unknown[];
    currentAskUserQuestionIndex: number;
  } | null = null;
  let run: Promise<unknown> | null = null;

  const session: any = {
    sessionId: 'session-1',
    binding: { canonicalRoot: '/tmp' },
    settings: {},
    service: {
      setLogSink: vi.fn(),
      getPendingInteractionSnapshot: () => snapshot,
      handleApprovalDecision: vi.fn(async () => null),
    },
    prepareMessage: vi.fn(async () => ({ kind: 'prepared', leaseId: 'lease-1', turnId: 'turn-1' })),
    commitMessage: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    // The real runtime refuses to resolve an interaction that moved on, and the
    // bridge turns that into an aborted turn (fail closed).
    resolvePendingInteraction: vi.fn((request: any) => {
      if (
        snapshot === null ||
        request.expectedInteractionId !== snapshot.interactionId ||
        (request.expectedRevision !== undefined && request.expectedRevision !== snapshot.revision)
      ) {
        throw new Error('stale interaction');
      }
      applied.push({
        answer: request.answer,
        ...(request.rejectionReason === undefined ? {} : { rejectionReason: request.rejectionReason }),
      });
      if (typeof request.answer === 'string' && request.answer.endsWith('-session')) grants.add(request.answer);
      snapshot = null;
      return { kind: 'resolved' };
    }),
  };

  const backend = createAcpV2SessionBackend({
    runtimeFactory: {
      create: vi.fn(async (_binding: unknown, createOptions: any) => {
        session.eventSink = createOptions.eventSink;
        return session;
      }),
    } as any,
    createId: () => 'session-1',
    writerFactory: noopWriterFactory as any,
    ...(options.decideApproval ? { decideApproval: options.decideApproval } : {}),
  });

  const controller = new AbortController();
  const client = {
    request: vi.fn(async (method: string, params: any, requestOptions: any) => {
      requests.push({ method, params, options: requestOptions });
      return await options.respond(params, requestOptions);
    }),
  };
  if (options.withClient !== false) backend.setClient?.('session-1', client as any, controller.signal);

  return {
    backend,
    session,
    client,
    controller,
    requests,
    updates,
    applied,
    grants,
    getRun: () => run,
    async open() {
      const cwd = mkdtempSync('/tmp/acp-permission-bridge-');
      await backend.createSession({ cwd });
      const execution = await backend.preparePrompt({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'run' }],
      });
      run = execution.run(async (update) => {
        updates.push(update);
      }, new AbortController().signal);
      await vi.waitFor(() => expect(session.commitMessage).toHaveBeenCalled());
      return cwd;
    },
    async present(approval: Approval, ids: { interactionId?: number; revision?: number } = {}) {
      const pending = {
        interactionId: ids.interactionId ?? 7,
        revision: ids.revision ?? 1,
        approval: { agentName: 'term2', ...approval },
        askUserAnswers: [] as unknown[],
        currentAskUserQuestionIndex: 0,
      };
      snapshot = pending;
      await session.eventSink({ type: 'approval_required', approval: pending.approval });
    },
    moveRevision() {
      if (snapshot) snapshot = { ...snapshot, revision: snapshot.revision + 1 };
    },
  };
};

const withHarness = async (
  options: HarnessOptions,
  body: (h: ReturnType<typeof createHarness>) => Promise<void>,
): Promise<void> => {
  const h = createHarness(options);
  const cwd = await h.open();
  try {
    await body(h);
  } finally {
    void h.getRun()?.catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
};

const shellApproval = (overrides: Approval = {}): Approval => ({
  toolName: 'shell',
  callId: 'tool-1',
  argumentsText: '{"command":"echo written > probe.txt"}',
  ...overrides,
});

// A denied workspace read: term2's own choices are
// allow-once / allow-remember / unsandboxed-once / deny.
const deniedReadApproval: Approval = {
  toolName: 'shell',
  callId: 'tool-1',
  argumentsText: '{"path":"/etc/hosts"}',
  deniedRead: { displayPath: '/etc/hosts', displayParent: '/etc', sensitive: false },
};

const failedUpdate = (toolCallId: string, text: string) =>
  expect.objectContaining({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    title: 'Approval required',
    status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  });

describe('ACP permission bridge', () => {
  it('offers the ordinary_tool approve/reject pair correlated with the real tool call id', async () => {
    await withHarness({ respond: () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }) }, async (h) => {
      await h.present(shellApproval());
      await vi.waitFor(() => expect(h.requests).toHaveLength(1));
      const request = h.requests[0]!;
      expect(request.method).toBe(acp.methods.client.session.requestPermission);
      expect(request.params).toMatchObject({
        sessionId: 'session-1',
        title: 'shell',
        description: '{"command":"echo written > probe.txt"}',
        subject: {
          type: 'tool_call',
          toolCall: { toolCallId: 'tool-1', title: 'shell', name: 'shell', status: 'pending' },
        },
        options: [
          { optionId: 'approve', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
      // The prompt's cancellation signal is the only way `session/cancel` can
      // reach a pending permission request.
      expect(request.options.cancellationSignal).toBe(h.controller.signal);

      expect(h.applied).toEqual([{ answer: 'n', rejectionReason: 'Permission denied by client.' }]);
      expect(h.grants.size).toBe(0);
      expect(h.updates).toContainEqual(failedUpdate('tool-1', 'Permission denied by client.'));
    });
  });

  it('denies when the client cancels the permission request', async () => {
    await withHarness({ respond: () => ({ outcome: { outcome: 'cancelled' } }) }, async (h) => {
      await h.present(shellApproval());
      await vi.waitFor(() => expect(h.requests).toHaveLength(1));
      expect(h.applied).toEqual([{ answer: 'n', rejectionReason: 'Permission request was cancelled.' }]);
      expect(h.grants.size).toBe(0);
      expect(h.updates).toContainEqual(failedUpdate('tool-1', 'Permission request was cancelled.'));
    });
  });

  it('denies an unknown option id', async () => {
    await withHarness(
      { respond: () => ({ outcome: { outcome: 'selected', optionId: 'unsandboxed-once' } }) },
      async (h) => {
        await h.present(shellApproval());
        await vi.waitFor(() => expect(h.requests).toHaveLength(1));
        expect(h.applied).toEqual([{ answer: 'n', rejectionReason: 'Client selected an unknown permission option.' }]);
        expect(h.grants.size).toBe(0);
        expect(h.updates).toContainEqual(failedUpdate('tool-1', 'Client selected an unknown permission option.'));
      },
    );
  });

  it('denies malformed responses: a missing outcome and a non-string option id', async () => {
    let call = 0;
    await withHarness(
      {
        respond: () => (call++ === 0 ? {} : { outcome: { outcome: 'selected', optionId: 42 } }),
      },
      async (h) => {
        await h.present(shellApproval({ callId: 'tool-1' }));
        await vi.waitFor(() => expect(h.requests).toHaveLength(1));
        await h.present(shellApproval({ callId: 'tool-2' }));
        await vi.waitFor(() => expect(h.requests).toHaveLength(2));
        expect(h.applied).toEqual([
          { answer: 'n', rejectionReason: 'Permission request was cancelled.' },
          { answer: 'n', rejectionReason: 'Permission request was cancelled.' },
        ]);
        expect(h.grants.size).toBe(0);
        expect(h.updates).toContainEqual(failedUpdate('tool-2', 'Permission request was cancelled.'));
      },
    );
  });

  it('denies when the permission request rejects (transport error or disconnect)', async () => {
    await withHarness(
      {
        respond: () => {
          throw new Error('client disconnected');
        },
      },
      async (h) => {
        await h.present(shellApproval());
        await vi.waitFor(() => expect(h.requests).toHaveLength(1));
        expect(h.applied).toEqual([{ answer: 'n', rejectionReason: 'Permission request failed.' }]);
        expect(h.grants.size).toBe(0);
        expect(h.updates).toContainEqual(failedUpdate('tool-1', 'Permission request failed.'));
      },
    );
  });

  it('aborts the pending request on session/cancel and never runs the tool', async () => {
    await withHarness(
      {
        // The SDK request settles only through the cancellation signal, the way
        // a real peer that never answers behaves.
        respond: (_params: any, requestOptions: any) =>
          new Promise((_resolve, reject) => {
            requestOptions.cancellationSignal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      },
      async (h) => {
        const approval = h.present(shellApproval());
        await vi.waitFor(() => expect(h.requests).toHaveLength(1));
        expect(h.requests[0]!.options.cancellationSignal.aborted).toBe(false);

        h.controller.abort();
        await h.backend.cancelSession('session-1');

        expect(h.requests[0]!.options.cancellationSignal.aborted).toBe(true);
        await approval;
        expect(h.session.abort).toHaveBeenCalledWith('turn-1');
        expect(h.applied).toEqual([{ answer: 'n', rejectionReason: 'Permission request failed.' }]);
        expect(h.grants.size).toBe(0);
        expect(h.updates).toContainEqual(failedUpdate('tool-1', 'Permission request failed.'));
      },
    );
  });

  it('aborts the pending request on session/close and still completes the close', async () => {
    await withHarness(
      {
        respond: (_params: any, requestOptions: any) =>
          new Promise((_resolve, reject) => {
            requestOptions.cancellationSignal.addEventListener('abort', () => reject(new Error('closed')), {
              once: true,
            });
          }),
      },
      async (h) => {
        const approval = h.present(shellApproval());
        await vi.waitFor(() => expect(h.requests).toHaveLength(1));

        await expect(h.backend.closeSession('session-1')).resolves.toBeUndefined();
        expect(h.session.dispose).toHaveBeenCalledTimes(1);

        h.controller.abort();
        await approval;
        expect(h.applied).toEqual([{ answer: 'n', rejectionReason: 'Permission request failed.' }]);
        expect(h.grants.size).toBe(0);
      },
    );
  });

  it('denies a stale interaction and aborts the turn instead of applying an allow', async () => {
    const pending = deferred();
    await withHarness({ respond: () => pending.promise }, async (h) => {
      const approval = h.present(shellApproval());
      await vi.waitFor(() => expect(h.requests).toHaveLength(1));

      // The interaction moved on while the client was deciding.
      h.moveRevision();
      pending.resolve({ outcome: { outcome: 'selected', optionId: 'approve' } });
      await approval;

      expect(h.applied).toEqual([]);
      expect(h.grants.size).toBe(0);
      expect(h.session.abort).toHaveBeenCalledWith('turn-1');
    });
  });

  it('never offers unsandboxed-once or allow-remember, even when term2 presents them', async () => {
    await withHarness({ respond: () => ({ outcome: { outcome: 'selected', optionId: 'deny' } }) }, async (h) => {
      await h.present(deniedReadApproval);
      await vi.waitFor(() => expect(h.requests).toHaveLength(1));

      expect(h.requests[0]!.params.options).toEqual([
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ]);
      const presented = JSON.stringify(h.requests[0]!.params.options);
      expect(presented).not.toContain('unsandboxed-once');
      expect(presented).not.toContain('allow-remember');

      expect(h.applied).toEqual([{ answer: 'n', rejectionReason: 'Permission denied by client.' }]);
      expect(h.grants.size).toBe(0);
    });
  });

  // DEFECT: an allow is resolved as a denial. In `source/acp-v2/session-backend.ts`
  // the resolution uses `answer: delivered ? answer : 'n'`, but `delivered` is
  // only set on the denial branch (the one that emits the failed update), so
  // every allow answer -- 'y' or a `*-session` choice -- is rewritten to 'n'
  // before it reaches the runtime. The client's allow is therefore never honored.
  it('resolves an approved tool call as the exact allow answer', async () => {
    await withHarness({ respond: () => ({ outcome: { outcome: 'selected', optionId: 'approve' } }) }, async (h) => {
      await h.present(shellApproval());
      await vi.waitFor(() => expect(h.requests).toHaveLength(1));
      expect(h.applied).toEqual([{ answer: 'y' }]);
      expect(h.updates).not.toContainEqual(expect.objectContaining({ status: 'failed' }));
    });
  });

  // DEFECT: same flag. An `allow_always` choice must reach term2 verbatim so its
  // session grant path (`approval-grant-executor.ts` /
  // `approval-flow-coordinator.ts`) can honor it; the bridge currently rewrites
  // it to 'n', so the grant is never applied and the next identical call is
  // denied again instead of being covered by the session grant.
  it('passes an allow_always session choice through verbatim and never re-asks it', async () => {
    await withHarness(
      { respond: () => ({ outcome: { outcome: 'selected', optionId: 'allow-folder-session' } }) },
      async (h) => {
        await h.present({ toolName: 'read_file', callId: 'tool-1', argumentsText: '{"path":"/tmp/a"}' });
        await vi.waitFor(() => expect(h.requests).toHaveLength(1));
        expect(h.requests[0]!.params.options).toEqual([
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-folder-session', name: 'Allow folder for session', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ]);

        expect(h.applied).toEqual([{ answer: 'allow-folder-session' }]);
        expect([...h.grants]).toEqual(['allow-folder-session']);

        // With the grant applied the runtime does not present the interaction
        // again, so the client is not asked a second time.
        await h.present({ toolName: 'read_file', callId: 'tool-2', argumentsText: '{"path":"/tmp/a"}' });
        expect(h.requests).toHaveLength(1);
      },
    );
  });

  it('does not replay a file session grant for a different outside-workspace file', async () => {
    await withHarness(
      { respond: () => ({ outcome: { outcome: 'selected', optionId: 'allow-edit-file-session' } }) },
      async (h) => {
        await h.present({
          toolName: 'edit_file',
          callId: 'tool-1',
          argumentsText: '{"path":"/outside/a.txt"}',
          outsideWorkspaceEdit: { path: '/outside/a.txt', folder: '/outside' },
        });
        await vi.waitFor(() => expect(h.requests).toHaveLength(1));

        await h.present({
          toolName: 'edit_file',
          callId: 'tool-2',
          argumentsText: '{"path":"/outside/b.txt"}',
          outsideWorkspaceEdit: { path: '/outside/b.txt', folder: '/outside' },
        });
        expect(h.requests).toHaveLength(2);
      },
    );
  });

  // DEFECT: the same `delivered` flag also breaks the pre-existing injected
  // `decideApproval` seam (M1's), not only the new client path: an injected
  // policy that allows resolves 'n' and the tool never runs.
  it('resolves an injected approval policy allow through the same path', async () => {
    await withHarness(
      {
        withClient: false,
        respond: () => ({ outcome: { outcome: 'cancelled' } }),
        decideApproval: async () => ({ answer: 'y' }),
      },
      async (h) => {
        await h.present(shellApproval());
        expect(h.applied).toEqual([{ answer: 'y' }]);
        expect(h.session.abort).not.toHaveBeenCalled();
      },
    );
  });
});
