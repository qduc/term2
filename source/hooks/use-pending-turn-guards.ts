import { useCallback, useMemo, useState } from 'react';
import { estimateLastTurnTokens } from '../app-helpers.js';
import type { ConversationService } from '../services/conversation/conversation-service.js';
import type { HistoryService } from '../services/history-service.js';
import type { LoggingService } from '../services/logging/logging-service.js';
import type { LargeUncachedInputDecision } from '../services/large-uncached-input-guard.js';
import type { UserTurn } from '../types/user-turn.js';
import type { ImageRef } from 'ink-prompt';

export type PendingTurnGuardResult = { status: 'ready'; turn: UserTurn } | { status: 'blocked' };

type SendUserMessage = (turn: UserTurn, options?: { bypassInputSurgeGuard?: boolean }) => Promise<void>;
type ImageSetter = (images: ImageRef[]) => void;

export type UsePendingTurnGuardsOptions = {
  input: string;
  mode: string;
  images: UserTurn['images'];
  conversationService: ConversationService;
  historyService: HistoryService;
  loggingService: LoggingService;
  sendUserMessage: SendUserMessage;
  setInput: (value: string) => void;
  setImages?: ImageSetter;
};

export type UsePendingTurnGuardsReturn = {
  largeUncachedWarning: LargeUncachedInputDecision | null;
  pendingLargeUncachedTurn: UserTurn | null;
  pendingLargeUncachedTokens: number;
  pendingSurgeTurn: UserTurn | null;
  pendingSurgeReason: string;
  guardTurn: (turn: UserTurn) => PendingTurnGuardResult;
  sendGuardedTurn: (turn: UserTurn) => Promise<boolean>;
  handleLargeUncachedApprove: () => Promise<void>;
  handleLargeUncachedDecline: () => void;
  handleSurgeApprove: () => Promise<void>;
  handleSurgeDecline: () => void;
};

export const usePendingTurnGuards = ({
  input,
  mode,
  images,
  conversationService,
  historyService,
  loggingService,
  sendUserMessage,
  setInput,
  setImages,
}: UsePendingTurnGuardsOptions): UsePendingTurnGuardsReturn => {
  const [pendingLargeUncachedTurn, setPendingLargeUncachedTurn] = useState<UserTurn | null>(null);
  const [pendingLargeUncachedTokens, setPendingLargeUncachedTokens] = useState(0);
  const [pendingSurgeTurn, setPendingSurgeTurn] = useState<UserTurn | null>(null);
  const [pendingSurgeReason, setPendingSurgeReason] = useState('');

  const largeUncachedWarning = useMemo(() => {
    if (!input || mode !== 'text' || input.startsWith('/')) {
      return null;
    }

    const preview = conversationService.previewLargeUncachedInput({ text: input }, Date.now());
    return preview.action === 'warn' ? preview : null;
  }, [conversationService, images, input, mode]);

  const sendReadyTurn = useCallback(
    async (turn: UserTurn, options?: { bypassInputSurgeGuard?: boolean }) => {
      historyService.addMessage(turn);
      setInput('');
      if (options) {
        await sendUserMessage(turn, options);
        return;
      }

      await sendUserMessage(turn);
    },
    [historyService, sendUserMessage, setInput],
  );

  const guardTurn = useCallback(
    (turn: UserTurn): PendingTurnGuardResult => {
      const surgePreview = conversationService.previewInputSurge(turn);
      if (surgePreview.action === 'block') {
        setPendingSurgeTurn(turn);
        setPendingSurgeReason(surgePreview.reason || 'Input surge detected');
        loggingService.debug('Input surge warning shown', {
          eventType: 'input_surge_warning_shown',
          category: 'provider',
          reason: surgePreview.reason,
          stats: surgePreview.stats,
          previousStats: surgePreview.previousStats,
        });
        return { status: 'blocked' };
      }

      const preview = conversationService.previewLargeUncachedInput(turn, Date.now());
      if (preview.action === 'warn') {
        setPendingLargeUncachedTurn(turn);
        setPendingLargeUncachedTokens(estimateLastTurnTokens(turn));
        loggingService.debug('Large uncached input warning shown', {
          eventType: 'large_uncached_input_warning_shown',
          category: 'provider',
          estimatedTokens: preview.estimatedTokens,
          estimatedBytes: preview.estimatedBytes,
          reasons: preview.reasons,
        });
        return { status: 'blocked' };
      }

      return { status: 'ready', turn };
    },
    [conversationService, loggingService],
  );

  const sendGuardedTurn = useCallback(
    async (turn: UserTurn): Promise<boolean> => {
      const guarded = guardTurn(turn);
      if (guarded.status === 'blocked') {
        return false;
      }

      await sendReadyTurn(guarded.turn);
      return true;
    },
    [guardTurn, sendReadyTurn],
  );

  const handleLargeUncachedApprove = useCallback(async () => {
    const turn = pendingLargeUncachedTurn;
    if (!turn) {
      return;
    }

    setPendingLargeUncachedTurn(null);
    setPendingLargeUncachedTokens(0);
    setImages?.([]);
    await sendReadyTurn(turn);
  }, [pendingLargeUncachedTurn, sendReadyTurn, setImages]);

  const handleLargeUncachedDecline = useCallback(() => {
    const turn = pendingLargeUncachedTurn;
    if (!turn) {
      return;
    }

    setPendingLargeUncachedTurn(null);
    setPendingLargeUncachedTokens(0);
    queueMicrotask(() => {
      setInput(turn.text || '');
    });
  }, [pendingLargeUncachedTurn, setInput]);

  const handleSurgeApprove = useCallback(async () => {
    const turn = pendingSurgeTurn;
    if (!turn) {
      return;
    }

    setPendingSurgeTurn(null);
    setPendingSurgeReason('');
    setImages?.([]);
    await sendReadyTurn(turn, { bypassInputSurgeGuard: true });
  }, [pendingSurgeTurn, sendReadyTurn, setImages]);

  const handleSurgeDecline = useCallback(() => {
    const turn = pendingSurgeTurn;
    if (!turn) {
      return;
    }

    setPendingSurgeTurn(null);
    setPendingSurgeReason('');
    queueMicrotask(() => {
      setInput(turn.text || '');
    });
  }, [pendingSurgeTurn, setInput]);

  return {
    largeUncachedWarning,
    pendingLargeUncachedTurn,
    pendingLargeUncachedTokens,
    pendingSurgeTurn,
    pendingSurgeReason,
    guardTurn,
    sendGuardedTurn,
    handleLargeUncachedApprove,
    handleLargeUncachedDecline,
    handleSurgeApprove,
    handleSurgeDecline,
  };
};
