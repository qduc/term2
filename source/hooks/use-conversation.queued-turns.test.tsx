// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { expect, it, vi } from 'vitest';
import React, { act } from 'react';
import type { ConversationTerminal } from '../contracts/conversation.js';
import type { ConversationService } from '../services/conversation/conversation-service.js';
import type { ILoggingService } from '../services/service-interfaces.js';
import { injectSkillIntoTurn, type UserTurn } from '../types/user-turn.js';
import { renderInAct } from '../test-helpers/ink-testing.js';
import { useConversation } from './use-conversation.js';

function attachedTurn(text: string, suffix: string): UserTurn {
  return {
    text,
    images: [{ id: `image-${suffix}`, data: `data-${suffix}`, mimeType: 'image/png', byteSize: 12, displayNumber: 1 }],
    skill: { name: `skill-${suffix}`, description: `Description ${suffix}`, body: `Instructions ${suffix}` },
  };
}

it.each(['steer', 'follow_up'] as const)(
  'preserves executable attachments through the real %s callbacks, edits, and queue projection',
  async (busyMode) => {
    let resolveSteer!: (admitted: boolean) => void;
    const steer = new Promise<boolean>((resolve) => {
      resolveSteer = resolve;
    });
    let resolveSend!: (terminal: ConversationTerminal) => void;
    const send = new Promise<ConversationTerminal>((resolve) => {
      resolveSend = resolve;
    });
    const service = {
      sessionId: 'queued-turn-projection',
      isQueueOwningSubmissions: vi.fn(() => true),
      isQueueActive: vi.fn(() => true),
      previewInputSurge: vi.fn(() => ({ action: 'allow' })),
      steerActiveTurn: vi.fn(() => steer),
      sendMessage: vi.fn(() => send),
      editSubmission: vi.fn<ConversationService['editSubmission']>().mockResolvedValue({
        kind: 'applied',
        stage: busyMode === 'steer' ? 'pending_steer' : 'queued',
      }),
    };
    const loggingService = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ILoggingService;
    let conversation!: ReturnType<typeof useConversation>;
    function Harness() {
      conversation = useConversation({
        conversationService: service as unknown as ConversationService,
        loggingService,
        historyService: { addMessage: vi.fn() },
      });
      return null;
    }
    await renderInAct(<Harness />);
    const original = attachedTurn('original request', 'original');
    let completion!: Promise<void>;

    await act(async () => {
      const admission = conversation.submitTurnForAdmission(original, { busyMode });
      expect(admission.kind).toBe('submitted');
      if (admission.kind === 'submitted') completion = admission.completion;
    });

    const initialRow = conversation.pendingQueuedMessages[0]!;
    expect(initialRow).toEqual({
      id: expect.any(String),
      turn: original,
      text: '[Skill: skill-original]\noriginal request\n[1 image attached]',
      delivery: busyMode,
      queuedAt: expect.any(Number),
    });

    const edited = attachedTurn('edited request', 'edited');
    await act(async () => {
      await conversation.editPendingSubmission(initialRow.id, edited);
    });
    expect(service.editSubmission).toHaveBeenCalledWith(initialRow.id, injectSkillIntoTurn(edited));
    expect(conversation.pendingQueuedMessages).toEqual([
      {
        ...initialRow,
        turn: edited,
        text: '[Skill: skill-edited]\nedited request\n[1 image attached]',
      },
    ]);

    service.editSubmission.mockResolvedValueOnce({ kind: 'too_late', stage: 'started' });
    const editedRow = conversation.pendingQueuedMessages[0]!;
    await act(async () => {
      await conversation.editPendingSubmission(initialRow.id, { text: 'rejected edit' });
    });
    expect(conversation.pendingQueuedMessages[0]).toBe(editedRow);

    if (busyMode === 'steer') {
      await act(async () => {
        resolveSteer(false);
      });
      expect(conversation.pendingQueuedMessages).toEqual([{ ...editedRow, delivery: 'follow_up' }]);
      expect(service.sendMessage).toHaveBeenCalledWith(
        injectSkillIntoTurn(edited),
        expect.objectContaining({ preferredMessageId: initialRow.id }),
      );
    }

    await act(async () => {
      resolveSend({ type: 'response', finalText: 'done', commandMessages: [] });
      await completion;
    });
    expect(conversation.pendingQueuedMessages).toEqual([]);
    expect(loggingService.error).not.toHaveBeenCalled();
  },
);
