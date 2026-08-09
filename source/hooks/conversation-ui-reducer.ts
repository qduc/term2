/**
 * Reducer for transient conversation UI state.
 *
 * Consolidates the ~9 useState calls that always reset together (approval
 * flags, processing state, streaming indicators) into a single state object
 * with domain-meaningful actions. This eliminates the duplicated 10-line
 * reset blocks that were copy-pasted across clearConversation, stopProcessing,
 * rewindToTurn and error catch blocks.
 *
 * Messages, lastUsage, and lastCodexRateLimit stay as separate state because
 * they have different update patterns (e.g. lastUsage is set via callbacks
 * passed to external factories).
 */

import type { NormalizedUsage } from '../utils/ai/token-usage.js';
import type { CodexRateLimitInfo } from '../services/conversation/conversation-events.js';
import type { PendingApproval } from '../contracts/conversation.js';
import type { QueuePauseReason } from '../services/queue/queue-controller.js';
import type { PendingInteractionSnapshot } from '../services/session/pending-interaction-state.js';
import type { SessionCostSummary } from '../services/cost/model-cost.js';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export type AskUserAnswer = string | string[];

type ApprovalInteraction =
  | { kind: 'prompt'; askUserAnswers?: AskUserAnswer[]; currentAskUserQuestionIndex?: number }
  | { kind: 'rejection_reason'; askUserAnswers?: AskUserAnswer[]; currentAskUserQuestionIndex?: number }
  | { kind: 'ask_user_answer'; askUserAnswers: AskUserAnswer[]; currentAskUserQuestionIndex: number };

export type TurnPhase =
  | { kind: 'idle' }
  | { kind: 'processing' }
  | { kind: 'processing_awaiting_approval'; approval: PendingApproval; interaction: ApprovalInteraction }
  | { kind: 'awaiting_approval'; approval: PendingApproval; interaction: ApprovalInteraction };

export type QueueStateKind =
  | 'idle'
  | 'running'
  | 'awaiting_active_action'
  | 'cancelling'
  | 'completing'
  | 'paused'
  | 'awaiting_preflight';

export interface QueueSnapshot {
  readonly queueLength: number;
  readonly stateKind: QueueStateKind;
  readonly pauseReason?: QueuePauseReason;
}

export interface ConversationUIFlags {
  isProcessing: boolean;
  pendingInteractionId: number | null;
  waitingForApproval: boolean;
  waitingForRejectionReason: boolean;
  waitingForAskUserAnswer: boolean;
  askUserAnswers: AskUserAnswer[];
  currentAskUserQuestionIndex: number;
  pendingApproval: PendingApproval | null;

  // Queue state
  queueActive: boolean;
  queuePaused: boolean;
  queueLength: number;
  queuePauseReason?: QueuePauseReason;
}

export interface ConversationUIState {
  turnPhase: TurnPhase;
  /** Read-only projection of the session-owned approval protocol. */
  pendingInteraction: PendingInteractionSnapshot | null;
  /** Ink-only choice to turn the composer into an answer/rejection field. */
  composerEntryMode: 'none' | 'rejection_reason' | 'ask_user_answer';

  // Streaming indicators
  thinkingStartedAt: number | null;
  toolCallStreamingInfo: { toolName?: string; argumentCharCount: number } | null;

  // Usage (included here so reset_all can clear them atomically)
  lastUsage: NormalizedUsage | null;
  lastCodexRateLimit: CodexRateLimitInfo | null;
  /** Reactive session cost summary, mirrored from the session cost accumulator. */
  costSummary: SessionCostSummary | null;

  // Queue state snapshot
  queueSnapshot: QueueSnapshot | null;

  // Messages queued behind an in-flight turn. Shown above the input box until
  // the queue actually starts processing each one, at which point it is moved
  // to the message list with the correct timeline.
  pendingQueuedMessages: ReadonlyArray<{ id: string; text: string; queuedAt: number }>;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ConversationUIAction =
  // --- Turn lifecycle ---
  /** A new turn (send or continuation) has started processing. */
  | { type: 'turn/started' }
  /** A turn completed or failed (used in finally blocks). */
  | { type: 'turn/completed' }

  // --- Streaming indicators ---
  | { type: 'streaming/thinking_started'; timestamp: number }
  | { type: 'streaming/thinking_cleared' }
  | { type: 'streaming/tool_info'; info: ConversationUIState['toolCallStreamingInfo'] }

  // --- Approval flow ---
  /** Approval is required; show the approval prompt. */
  | { type: 'approval/requested'; approval: PendingApproval }
  /** User resolved the approval (approved or rejected). */
  | { type: 'approval/resolved' }
  /** Replace the local projection with the session's authoritative snapshot. */
  | { type: 'interaction/snapshot'; snapshot: PendingInteractionSnapshot | null }
  /** Enter or leave the Ink composer mode for the current interaction. */
  | { type: 'interaction/composer_entry'; mode: ConversationUIState['composerEntryMode'] }
  /** User clicked to start typing an ask_user answer. */
  | { type: 'ask_user/set_waiting' }
  /** Clear the ask_user waiting state without resolving approval. */
  | { type: 'ask_user/clear_waiting' }
  /** User submitted an answer to the current ask_user question. */
  | { type: 'ask_user/answer_submitted'; answer: AskUserAnswer }
  /** Advance to the next ask_user question. */
  | { type: 'ask_user/advance_to_next'; nextIndex: number }
  /** Go back to the previous ask_user question. */
  | { type: 'ask_user/go_back' }
  /** Show the rejection reason input. */
  | { type: 'rejection/set_waiting' }
  /** Clear the rejection reason input. */
  | { type: 'rejection/cleared' }

  // --- Max turns ---
  /** Max turns approved — clear approval state and start processing. */
  | { type: 'max_turns/approved' }
  /** Max turns declined — clear approval state and stop. */
  | { type: 'max_turns/declined' }

  // --- Usage ---
  | { type: 'usage/updated'; usage: NormalizedUsage }
  | { type: 'usage/cleared' }
  | { type: 'cost/updated'; summary: SessionCostSummary }
  | { type: 'rate_limit/updated'; rateLimit: CodexRateLimitInfo }
  | { type: 'rate_limit/cleared' }

  // --- Queue state ---
  | { type: 'queue/updated'; snapshot: QueueSnapshot }
  /** A user message is queued behind an in-flight turn; show it above the input box. */
  | { type: 'queue/message_pending'; id: string; text: string; queuedAt: number }
  /** The queue has started executing the queued message; remove it from the pending list. */
  | { type: 'queue/message_started'; id: string }
  /** A queued message was removed or rejected before execution started. */
  | { type: 'queue/message_removed'; id: string }
  /** A pending submission (steer or queued) was edited in place; stage and position are unchanged. */
  | { type: 'queue/message_edited'; id: string; text: string }

  // --- Compound resets ---
  /** Reset transient approval/processing/indicator state (used by stop, rewind, etc.). */
  | { type: 'reset_transient' }
  /** Full reset including usage (used by clearConversation). */
  | { type: 'reset_all' };

// ---------------------------------------------------------------------------
// Initial state factory
// ---------------------------------------------------------------------------

export function createInitialUIState(initialUsage: NormalizedUsage | null): ConversationUIState {
  return {
    turnPhase: { kind: 'idle' },
    pendingInteraction: null,
    composerEntryMode: 'none',
    thinkingStartedAt: null,
    toolCallStreamingInfo: null,
    lastUsage: initialUsage,
    lastCodexRateLimit: null,
    costSummary: null,
    queueSnapshot: null,
    pendingQueuedMessages: [],
  };
}

function isApprovalPhase(
  phase: TurnPhase,
): phase is Extract<TurnPhase, { kind: 'processing_awaiting_approval' | 'awaiting_approval' }> {
  return phase.kind === 'processing_awaiting_approval' || phase.kind === 'awaiting_approval';
}

function isProcessingPhase(phase: TurnPhase): boolean {
  return phase.kind === 'processing' || phase.kind === 'processing_awaiting_approval';
}

function getAskUserState(interaction: ApprovalInteraction): {
  askUserAnswers: AskUserAnswer[];
  currentAskUserQuestionIndex: number;
} {
  if (interaction.kind === 'ask_user_answer') {
    return {
      askUserAnswers: interaction.askUserAnswers,
      currentAskUserQuestionIndex: interaction.currentAskUserQuestionIndex,
    };
  }

  return {
    askUserAnswers: interaction.askUserAnswers ?? [],
    currentAskUserQuestionIndex: interaction.currentAskUserQuestionIndex ?? 0,
  };
}

function toPromptInteraction(interaction: ApprovalInteraction): ApprovalInteraction {
  const { askUserAnswers, currentAskUserQuestionIndex } = getAskUserState(interaction);
  return { kind: 'prompt', askUserAnswers, currentAskUserQuestionIndex };
}

function withInteraction(phase: TurnPhase, interaction: ApprovalInteraction): TurnPhase {
  if (!isApprovalPhase(phase)) {
    return phase;
  }

  return { ...phase, interaction };
}

function createApprovalInteraction(approval: PendingApproval): ApprovalInteraction {
  if (approval.toolName === 'ask_user') {
    return { kind: 'prompt', askUserAnswers: [], currentAskUserQuestionIndex: 0 };
  }

  return { kind: 'prompt' };
}

function createApprovalPhase(current: TurnPhase, approval: PendingApproval): TurnPhase {
  const interaction = createApprovalInteraction(approval);
  return isProcessingPhase(current)
    ? { kind: 'processing_awaiting_approval', approval, interaction }
    : { kind: 'awaiting_approval', approval, interaction };
}

const QUEUE_ACTIVE_KINDS: ReadonlySet<QueueStateKind> = new Set([
  'running',
  'awaiting_active_action',
  'cancelling',
  'completing',
]);

export function getConversationUIFlags(state: ConversationUIState): ConversationUIFlags {
  const phase = state.turnPhase;
  const queueSnapshot = state.queueSnapshot;
  const queueActive = queueSnapshot !== null && QUEUE_ACTIVE_KINDS.has(queueSnapshot.stateKind);
  const queuePaused = queueSnapshot?.stateKind === 'paused';
  const queueLength = queueSnapshot?.queueLength ?? 0;
  const isProcessing = isProcessingPhase(phase) || (queueActive && phase.kind !== 'awaiting_approval');

  const projected = state.pendingInteraction;
  if (projected) {
    return {
      isProcessing,
      pendingInteractionId: projected.interactionId,
      waitingForApproval: true,
      waitingForRejectionReason: state.composerEntryMode === 'rejection_reason',
      waitingForAskUserAnswer:
        projected.approval.toolName === 'ask_user' && state.composerEntryMode === 'ask_user_answer',
      askUserAnswers: [...projected.askUserAnswers],
      currentAskUserQuestionIndex: projected.currentAskUserQuestionIndex,
      pendingApproval: projected.approval,
      queueActive,
      queuePaused,
      queueLength,
      queuePauseReason: queueSnapshot?.pauseReason,
    };
  }

  if (!isApprovalPhase(phase)) {
    return {
      isProcessing,
      pendingInteractionId: null,
      waitingForApproval: false,
      waitingForRejectionReason: false,
      waitingForAskUserAnswer: false,
      askUserAnswers: [],
      currentAskUserQuestionIndex: 0,
      pendingApproval: null,
      queueActive,
      queuePaused,
      queueLength,
      queuePauseReason: queueSnapshot?.pauseReason,
    };
  }

  const askUserState = getAskUserState(phase.interaction);
  return {
    isProcessing,
    pendingInteractionId: null,
    waitingForApproval: true,
    waitingForRejectionReason: phase.interaction.kind === 'rejection_reason',
    waitingForAskUserAnswer: phase.interaction.kind === 'ask_user_answer',
    askUserAnswers: askUserState.askUserAnswers,
    currentAskUserQuestionIndex: askUserState.currentAskUserQuestionIndex,
    pendingApproval: phase.approval,
    queueActive,
    queuePaused,
    queueLength,
    queuePauseReason: queueSnapshot?.pauseReason,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function conversationUIReducer(state: ConversationUIState, action: ConversationUIAction): ConversationUIState {
  switch (action.type) {
    // --- Turn lifecycle ---
    case 'turn/started':
      if (state.turnPhase.kind !== 'idle') {
        return state;
      }

      return {
        ...state,
        turnPhase: { kind: 'processing' },
        thinkingStartedAt: null,
        toolCallStreamingInfo: null,
      };

    case 'turn/completed': {
      const nextPhase =
        state.turnPhase.kind === 'processing'
          ? { kind: 'idle' as const }
          : state.turnPhase.kind === 'processing_awaiting_approval'
          ? {
              kind: 'awaiting_approval' as const,
              approval: state.turnPhase.approval,
              interaction: state.turnPhase.interaction,
            }
          : state.turnPhase;

      return {
        ...state,
        turnPhase: nextPhase,
        thinkingStartedAt: null,
      };
    }

    // --- Streaming indicators ---
    case 'streaming/thinking_started':
      return {
        ...state,
        // Only set once per reasoning burst (keep first timestamp)
        thinkingStartedAt: state.thinkingStartedAt ?? action.timestamp,
      };

    case 'streaming/thinking_cleared':
      return { ...state, thinkingStartedAt: null };

    case 'streaming/tool_info':
      return { ...state, toolCallStreamingInfo: action.info };

    // --- Approval flow ---
    case 'approval/requested':
      return {
        ...state,
        turnPhase: createApprovalPhase(state.turnPhase, action.approval),
      };

    case 'approval/resolved':
      return {
        ...state,
        turnPhase: isProcessingPhase(state.turnPhase) ? { kind: 'processing' } : { kind: 'idle' },
      };

    case 'interaction/snapshot': {
      const sameInteraction =
        action.snapshot !== null && state.pendingInteraction?.interactionId === action.snapshot.interactionId;
      return {
        ...state,
        pendingInteraction: action.snapshot,
        composerEntryMode: sameInteraction ? state.composerEntryMode : 'none',
      };
    }

    case 'interaction/composer_entry':
      if (!state.pendingInteraction) return state;
      if (action.mode === 'ask_user_answer' && state.pendingInteraction.approval.toolName !== 'ask_user') {
        return state;
      }
      return { ...state, composerEntryMode: action.mode };

    case 'ask_user/set_waiting': {
      if (!isApprovalPhase(state.turnPhase) || state.turnPhase.approval.toolName !== 'ask_user') {
        return state;
      }

      const askUserState = getAskUserState(state.turnPhase.interaction);
      return {
        ...state,
        turnPhase: withInteraction(state.turnPhase, { kind: 'ask_user_answer', ...askUserState }),
      };
    }

    case 'ask_user/clear_waiting':
      if (!isApprovalPhase(state.turnPhase) || state.turnPhase.interaction.kind !== 'ask_user_answer') {
        return state;
      }

      return {
        ...state,
        turnPhase: withInteraction(state.turnPhase, toPromptInteraction(state.turnPhase.interaction)),
      };

    case 'ask_user/answer_submitted': {
      if (!isApprovalPhase(state.turnPhase) || state.turnPhase.approval.toolName !== 'ask_user') {
        return state;
      }

      const askUserState = getAskUserState(state.turnPhase.interaction);
      return {
        ...state,
        turnPhase: withInteraction(state.turnPhase, {
          kind: 'ask_user_answer',
          askUserAnswers: [...askUserState.askUserAnswers, action.answer],
          currentAskUserQuestionIndex: askUserState.currentAskUserQuestionIndex,
        }),
      };
    }

    case 'ask_user/advance_to_next': {
      if (!isApprovalPhase(state.turnPhase) || state.turnPhase.approval.toolName !== 'ask_user') {
        return state;
      }

      const askUserState = getAskUserState(state.turnPhase.interaction);
      return {
        ...state,
        turnPhase: withInteraction(state.turnPhase, {
          kind: 'prompt',
          askUserAnswers: askUserState.askUserAnswers,
          currentAskUserQuestionIndex: action.nextIndex,
        }),
      };
    }

    case 'ask_user/go_back': {
      if (!isApprovalPhase(state.turnPhase) || state.turnPhase.approval.toolName !== 'ask_user') {
        return state;
      }

      const askUserState = getAskUserState(state.turnPhase.interaction);
      return {
        ...state,
        turnPhase: withInteraction(state.turnPhase, {
          kind: 'prompt',
          currentAskUserQuestionIndex: Math.max(0, askUserState.currentAskUserQuestionIndex - 1),
          askUserAnswers: askUserState.askUserAnswers.slice(0, -1),
        }),
      };
    }

    case 'rejection/set_waiting':
      if (!isApprovalPhase(state.turnPhase)) {
        return state;
      }

      return {
        ...state,
        turnPhase: withInteraction(state.turnPhase, {
          ...getAskUserState(state.turnPhase.interaction),
          kind: 'rejection_reason',
        }),
      };

    case 'rejection/cleared':
      if (!isApprovalPhase(state.turnPhase) || state.turnPhase.interaction.kind !== 'rejection_reason') {
        return state;
      }

      return {
        ...state,
        turnPhase: withInteraction(state.turnPhase, toPromptInteraction(state.turnPhase.interaction)),
      };

    // --- Max turns ---
    case 'max_turns/approved':
      return {
        ...state,
        turnPhase: { kind: 'processing' },
        thinkingStartedAt: null,
        toolCallStreamingInfo: null,
      };

    case 'max_turns/declined':
      return {
        ...state,
        turnPhase: { kind: 'idle' },
        thinkingStartedAt: null,
        toolCallStreamingInfo: null,
      };

    // --- Usage ---
    case 'usage/updated':
      return { ...state, lastUsage: action.usage };

    case 'usage/cleared':
      return { ...state, lastUsage: null };

    case 'cost/updated':
      return { ...state, costSummary: action.summary };

    case 'rate_limit/updated':
      return { ...state, lastCodexRateLimit: action.rateLimit };

    case 'rate_limit/cleared':
      return { ...state, lastCodexRateLimit: null };

    // --- Queue state ---
    case 'queue/updated':
      return { ...state, queueSnapshot: action.snapshot };

    case 'queue/message_pending':
      // Append in submission order; do not dedupe by id because the same id
      // could (in principle) be re-queued after a previous rejection.
      return {
        ...state,
        pendingQueuedMessages: [
          ...state.pendingQueuedMessages,
          { id: action.id, text: action.text, queuedAt: action.queuedAt },
        ],
      };

    case 'queue/message_started':
      if (!state.pendingQueuedMessages.some((m) => m.id === action.id)) {
        return state;
      }
      return {
        ...state,
        pendingQueuedMessages: state.pendingQueuedMessages.filter((m) => m.id !== action.id),
      };

    case 'queue/message_removed':
      if (!state.pendingQueuedMessages.some((m) => m.id === action.id)) {
        return state;
      }
      return {
        ...state,
        pendingQueuedMessages: state.pendingQueuedMessages.filter((m) => m.id !== action.id),
      };

    case 'queue/message_edited':
      if (!state.pendingQueuedMessages.some((m) => m.id === action.id)) {
        return state;
      }
      return {
        ...state,
        pendingQueuedMessages: state.pendingQueuedMessages.map((m) =>
          m.id === action.id ? { ...m, text: action.text } : m,
        ),
      };

    // --- Compound resets ---
    case 'reset_transient':
      return {
        ...state,
        turnPhase: { kind: 'idle' },
        pendingInteraction: null,
        composerEntryMode: 'none',
        thinkingStartedAt: null,
        toolCallStreamingInfo: null,
        queueSnapshot: null,
      };

    case 'reset_all':
      return createInitialUIState(null);
  }
}
