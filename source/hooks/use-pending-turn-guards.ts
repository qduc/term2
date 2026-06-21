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

type PendingState =
  | { kind: 'idle' }
  | { kind: 'pending_surge'; turn: UserTurn; reason: string }
  | { kind: 'pending_large_uncached'; turn: UserTurn; tokens: number };

export const usePendingTurnGuards = ({
  input,
  mode,
  images: _images,
  conversationService,
  historyService,
  loggingService,
  sendUserMessage,
  setInput,
  setImages,
}: UsePendingTurnGuardsOptions): UsePendingTurnGuardsReturn => {
  const [pendingState, setPendingState] = useState<PendingState>({ kind: 'idle' });

  const pendingLargeUncachedTurn = pendingState.kind === 'pending_large_uncached' ? pendingState.turn : null;
  const pendingLargeUncachedTokens = pendingState.kind === 'pending_large_uncached' ? pendingState.tokens : 0;
  const pendingSurgeTurn = pendingState.kind === 'pending_surge' ? pendingState.turn : null;
  const pendingSurgeReason = pendingState.kind === 'pending_surge' ? pendingState.reason : '';

  const largeUncachedWarning = useMemo(() => {
    if (!input || mode !== 'text' || input.startsWith('/')) {
      return null;
    }

    const preview = conversationService.previewLargeUncachedInput({ text: input }, Date.now());
    return preview.action === 'warn' ? preview : null;
  }, [conversationService, input, mode]);

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
        setPendingState({
          kind: 'pending_surge',
          turn,
          reason: surgePreview.reason || 'Input surge detected',
        });
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
        setPendingState({
          kind: 'pending_large_uncached',
          turn,
          tokens: estimateLastTurnTokens(turn),
        });
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
    if (pendingState.kind !== 'pending_large_uncached') {
      return;
    }
    const { turn } = pendingState;

    setPendingState({ kind: 'idle' });
    setImages?.([]);
    await sendReadyTurn(turn);
  }, [pendingState, sendReadyTurn, setImages]);

  const handleLargeUncachedDecline = useCallback(() => {
    if (pendingState.kind !== 'pending_large_uncached') {
      return;
    }
    const { turn } = pendingState;

    setPendingState({ kind: 'idle' });
    queueMicrotask(() => {
      setInput(turn.text || '');
    });
  }, [pendingState, setInput]);

  const handleSurgeApprove = useCallback(async () => {
    if (pendingState.kind !== 'pending_surge') {
      return;
    }
    const { turn } = pendingState;

    setPendingState({ kind: 'idle' });
    setImages?.([]);
    await sendReadyTurn(turn, { bypassInputSurgeGuard: true });
  }, [pendingState, sendReadyTurn, setImages]);

  const handleSurgeDecline = useCallback(() => {
    if (pendingState.kind !== 'pending_surge') {
      return;
    }
    const { turn } = pendingState;

    setPendingState({ kind: 'idle' });
    queueMicrotask(() => {
      setInput(turn.text || '');
    });
  }, [pendingState, setInput]);

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
