/**
 * Reducer for transient conversation UI state.
 *
 * Consolidates the ~9 useState calls that always reset together (approval
 * flags, processing state, streaming indicators) into a single state object
 * with domain-meaningful actions. This eliminates the duplicated 10-line
 * reset blocks that were copy-pasted across clearConversation, stopProcessing,
 * undoLastUserMessage, undoToUserMessage, and error catch blocks.
 *
 * Messages, lastUsage, and lastCodexRateLimit stay as separate state because
 * they have different update patterns (e.g. lastUsage is set via callbacks
 * passed to external factories).
 */

import type { NormalizedUsage } from '../utils/ai/token-usage.js';
import type { CodexRateLimitInfo } from '../services/conversation/conversation-events.js';
import type { PendingApproval } from '../contracts/conversation.js';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface ConversationUIState {
  // Processing lifecycle
  isProcessing: boolean;
  thinkingStartedAt: number | null;
  toolCallStreamingInfo: { toolName?: string; argumentCharCount: number } | null;

  // Approval flow
  waitingForApproval: boolean;
  waitingForRejectionReason: boolean;
  waitingForAskUserAnswer: boolean;
  askUserAnswers: (string | string[])[];
  currentAskUserQuestionIndex: number;
  pendingApproval: PendingApproval | null;

  // Usage (included here so reset_all can clear them atomically)
  lastUsage: NormalizedUsage | null;
  lastCodexRateLimit: CodexRateLimitInfo | null;
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
  /** User clicked to start typing an ask_user answer. */
  | { type: 'ask_user/set_waiting' }
  /** Clear the ask_user waiting state without resolving approval. */
  | { type: 'ask_user/clear_waiting' }
  /** User submitted an answer to the current ask_user question. */
  | { type: 'ask_user/answer_submitted'; answer: string | string[] }
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
  | { type: 'rate_limit/updated'; rateLimit: CodexRateLimitInfo }
  | { type: 'rate_limit/cleared' }

  // --- Compound resets ---
  /** Reset transient approval/processing/indicator state (used by stop, undo, etc.). */
  | { type: 'reset_transient' }
  /** Full reset including usage (used by clearConversation). */
  | { type: 'reset_all' };

// ---------------------------------------------------------------------------
// Initial state factory
// ---------------------------------------------------------------------------

export function createInitialUIState(initialUsage: NormalizedUsage | null): ConversationUIState {
  return {
    isProcessing: false,
    thinkingStartedAt: null,
    toolCallStreamingInfo: null,
    waitingForApproval: false,
    waitingForRejectionReason: false,
    waitingForAskUserAnswer: false,
    askUserAnswers: [],
    currentAskUserQuestionIndex: 0,
    pendingApproval: null,
    lastUsage: initialUsage,
    lastCodexRateLimit: null,
  };
}

// ---------------------------------------------------------------------------
// Default sub-states for compound resets
// ---------------------------------------------------------------------------

const TRANSIENT_DEFAULTS: Omit<ConversationUIState, 'lastUsage' | 'lastCodexRateLimit'> = {
  isProcessing: false,
  thinkingStartedAt: null,
  toolCallStreamingInfo: null,
  waitingForApproval: false,
  waitingForRejectionReason: false,
  waitingForAskUserAnswer: false,
  askUserAnswers: [],
  currentAskUserQuestionIndex: 0,
  pendingApproval: null,
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function conversationUIReducer(state: ConversationUIState, action: ConversationUIAction): ConversationUIState {
  switch (action.type) {
    // --- Turn lifecycle ---
    case 'turn/started':
      return {
        ...state,
        isProcessing: true,
        thinkingStartedAt: null,
        toolCallStreamingInfo: null,
      };

    case 'turn/completed':
      return {
        ...state,
        isProcessing: false,
        thinkingStartedAt: null,
      };

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
        waitingForApproval: true,
        pendingApproval: action.approval,
        waitingForAskUserAnswer: false,
        // If this is a new ask_user approval, reset ask_user state
        ...(action.approval.toolName === 'ask_user' ? { askUserAnswers: [], currentAskUserQuestionIndex: 0 } : {}),
      };

    case 'approval/resolved':
      return {
        ...state,
        waitingForApproval: false,
        pendingApproval: null,
        waitingForAskUserAnswer: false,
        askUserAnswers: [],
        currentAskUserQuestionIndex: 0,
      };

    case 'ask_user/set_waiting':
      return { ...state, waitingForAskUserAnswer: true };

    case 'ask_user/clear_waiting':
      return { ...state, waitingForAskUserAnswer: false };

    case 'ask_user/answer_submitted':
      return {
        ...state,
        askUserAnswers: [...state.askUserAnswers, action.answer],
      };

    case 'ask_user/advance_to_next':
      return {
        ...state,
        currentAskUserQuestionIndex: action.nextIndex,
        waitingForAskUserAnswer: false,
      };

    case 'ask_user/go_back':
      return {
        ...state,
        currentAskUserQuestionIndex: Math.max(0, state.currentAskUserQuestionIndex - 1),
        askUserAnswers: state.askUserAnswers.slice(0, -1),
        waitingForAskUserAnswer: false,
      };

    case 'rejection/set_waiting':
      return { ...state, waitingForRejectionReason: true };

    case 'rejection/cleared':
      return { ...state, waitingForRejectionReason: false };

    // --- Max turns ---
    case 'max_turns/approved':
      return {
        ...state,
        ...TRANSIENT_DEFAULTS,
        isProcessing: true,
      };

    case 'max_turns/declined':
      return {
        ...state,
        ...TRANSIENT_DEFAULTS,
      };

    // --- Usage ---
    case 'usage/updated':
      return { ...state, lastUsage: action.usage };

    case 'usage/cleared':
      return { ...state, lastUsage: null };

    case 'rate_limit/updated':
      return { ...state, lastCodexRateLimit: action.rateLimit };

    case 'rate_limit/cleared':
      return { ...state, lastCodexRateLimit: null };

    // --- Compound resets ---
    case 'reset_transient':
      return { ...state, ...TRANSIENT_DEFAULTS };

    case 'reset_all':
      return createInitialUIState(null);
  }
}
