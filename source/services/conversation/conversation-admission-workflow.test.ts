import { describe, expect, it, vi } from 'vitest';
import {
  ConversationAdmissionWorkflow,
  type ConversationAdmissionWorkflowDependencies,
} from './conversation-admission-workflow.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { InputSurgeDecision } from '../input-surge-guard.js';
import type { LargeUncachedInputDecision } from '../large-uncached-input-guard.js';

const turn: UserTurn = { text: 'Ship the workflow', images: [] };

const allowedSurge: InputSurgeDecision = {
  action: 'allow' as const,
  stats: {
    messageCount: 1,
    totalSerializedBytes: 24,
    duplicateToolCallSignatures: 0,
    maxDuplicateToolCallSignatureCount: 0,
  },
};

const allowedLarge: LargeUncachedInputDecision = {
  action: 'allow' as const,
  warningKey: 'allowed',
  reasons: [],
  estimatedTokens: 12,
  estimatedBytes: 48,
};

const warnedLarge: LargeUncachedInputDecision = {
  action: 'warn' as const,
  warningKey: 'warned',
  reasons: ['idle_timeout'],
  estimatedTokens: 72_100,
  estimatedBytes: 288_400,
};

const blockedSurge: InputSurgeDecision = {
  action: 'block' as const,
  reason: 'Input grew too quickly',
  stats: {
    messageCount: 8,
    totalSerializedBytes: 200_000,
    duplicateToolCallSignatures: 3,
    maxDuplicateToolCallSignatureCount: 4,
  },
  previousStats: {
    messageCount: 7,
    totalSerializedBytes: 2_000,
    duplicateToolCallSignatures: 0,
    maxDuplicateToolCallSignatureCount: 1,
  },
};

const createWorkflow = (overrides: Partial<ConstructorParameters<typeof ConversationAdmissionWorkflow>[0]> = {}) => {
  const history = { addMessage: vi.fn() };
  const logger = { debug: vi.fn() };
  const send = vi.fn(async () => {});
  const conversation: ConversationAdmissionWorkflowDependencies['conversation'] = {
    previewInputSurge: vi.fn(() => allowedSurge),
    previewLargeUncachedInput: vi.fn(() => allowedLarge),
  };

  return {
    workflow: new ConversationAdmissionWorkflow({
      conversation,
      history,
      logger,
      send,
      now: () => 123,
      ...overrides,
    }),
    history,
    logger,
    send,
    conversation,
  };
};

describe('ConversationAdmissionWorkflow', () => {
  it('records history before sending an admitted turn', async () => {
    const { workflow, history, send } = createWorkflow();

    const result = workflow.submit(turn, { busyMode: 'follow_up' });
    expect(result.kind).toBe('submitted');
    if (result.kind !== 'submitted') throw new Error('Expected submission');
    await result.completion;

    expect(history.addMessage).toHaveBeenCalledWith(turn);
    expect(send).toHaveBeenCalledWith(turn, { busyMode: 'follow_up' });
    expect(history.addMessage.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
  });

  it('rejects a caller-supplied bypass and only creates one after surge approval', async () => {
    const { workflow, send } = createWorkflow();

    const result = workflow.submit(turn, { bypassInputSurgeGuard: true } as any);
    if (result.kind !== 'submitted') throw new Error('Expected submission');
    await result.completion;

    expect(send).toHaveBeenCalledWith(turn, {});
  });

  it('sends an approved surge with a bypass and preserved busy mode', async () => {
    const { workflow, conversation, logger, send } = createWorkflow();
    (conversation.previewInputSurge as any).mockReturnValue(blockedSurge);

    const first = workflow.submit(turn, { busyMode: 'steer' });
    expect(first.kind).toBe('confirmation_required');
    if (first.kind !== 'confirmation_required') throw new Error('Expected confirmation');
    expect(first.confirmation.kind).toBe('surge');

    const approved = workflow.resolve(first.confirmation.id, 'approve');
    if (approved.kind !== 'submitted') throw new Error('Expected submission');
    await approved.completion;
    expect(send).toHaveBeenCalledWith(turn, { busyMode: 'steer', bypassInputSurgeGuard: true });
    expect(conversation.previewLargeUncachedInput).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'Input surge warning shown',
      expect.objectContaining({
        eventType: 'input_surge_warning_shown',
        category: 'provider',
        reason: blockedSurge.reason,
        stats: blockedSurge.stats,
        previousStats: blockedSurge.previousStats,
      }),
    );
  });

  it('does not create a surge bypass for a large uncached approval', async () => {
    const { workflow, conversation, logger, send } = createWorkflow();
    (conversation.previewLargeUncachedInput as any).mockReturnValue(warnedLarge);

    const pending = workflow.submit(turn);
    if (pending.kind !== 'confirmation_required') throw new Error('Expected confirmation');

    const approved = workflow.resolve(pending.confirmation.id, 'approve');
    if (approved.kind !== 'submitted') throw new Error('Expected submission');
    await approved.completion;

    expect(send).toHaveBeenCalledWith(turn, {});
    expect(logger.debug).toHaveBeenCalledWith(
      'Large uncached input warning shown',
      expect.objectContaining({
        eventType: 'large_uncached_input_warning_shown',
        category: 'provider',
        estimatedTokens: warnedLarge.estimatedTokens,
        estimatedBytes: warnedLarge.estimatedBytes,
        reasons: warnedLarge.reasons,
      }),
    );
  });

  it('bypasses large uncached input warning when busyMode is set (agent running)', async () => {
    const { workflow, conversation, send } = createWorkflow();
    (conversation.previewLargeUncachedInput as any).mockReturnValue(warnedLarge);

    const result = workflow.submit(turn, { busyMode: 'steer' });
    expect(result.kind).toBe('submitted');
    if (result.kind !== 'submitted') throw new Error('Expected submission');
    await result.completion;

    expect(conversation.previewLargeUncachedInput).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(turn, { busyMode: 'steer' });
  });

  it('consumes a matching confirmation before awaiting and ignores stale or repeated decisions', async () => {
    let releaseSend: (() => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSend = resolve;
        }),
    );
    const { workflow, conversation, history } = createWorkflow({ send });
    (conversation.previewLargeUncachedInput as any).mockReturnValue(warnedLarge);
    const pending = workflow.submit(turn);
    if (pending.kind !== 'confirmation_required') throw new Error('Expected confirmation');

    const approving = workflow.resolve(pending.confirmation.id, 'approve');
    expect(workflow.getSnapshot()).toBeNull();
    expect(workflow.resolve(pending.confirmation.id, 'approve')).toEqual({ kind: 'stale' });
    expect(workflow.resolve('missing', 'decline')).toEqual({ kind: 'stale' });
    expect(history.addMessage).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);

    if (approving.kind !== 'submitted') throw new Error('Expected submission');
    releaseSend?.();
    await approving.completion;
  });

  it('returns a declined turn without recording or sending it', async () => {
    const { workflow, conversation, history, send } = createWorkflow();
    (conversation.previewLargeUncachedInput as any).mockReturnValue(warnedLarge);
    const pending = workflow.submit(turn);
    if (pending.kind !== 'confirmation_required') throw new Error('Expected confirmation');

    expect(workflow.resolve(pending.confirmation.id, 'decline')).toEqual({ kind: 'declined', turn });
    expect(history.addMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not let a stale confirmation A affect a newer confirmation B', async () => {
    const { workflow, conversation, history, send } = createWorkflow();
    (conversation.previewLargeUncachedInput as any).mockReturnValue(warnedLarge);
    const first = workflow.submit({ text: 'A' });
    if (first.kind !== 'confirmation_required') throw new Error('Expected confirmation A');
    workflow.resolve(first.confirmation.id, 'decline');
    const second = workflow.submit({ text: 'B' });
    if (second.kind !== 'confirmation_required') throw new Error('Expected confirmation B');

    expect(workflow.resolve(first.confirmation.id, 'approve')).toEqual({ kind: 'stale' });
    expect(workflow.getSnapshot()?.id).toBe(second.confirmation.id);
    expect(history.addMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
