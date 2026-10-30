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
import { formatUserTurnForDisplay } from '../types/user-turn.js';
export function createInitialUIState(initialUsage) {
    return {
        turnPhase: { kind: 'idle' },
        pendingInteraction: null,
        composerEntryMode: 'none',
        thinkingStartedAt: null,
        retryCountdown: null,
        toolCallStreamingInfo: null,
        liveStreamingSpeed: null,
        lastUsage: initialUsage,
        lastCodexRateLimit: null,
        runBudgetNotice: null,
        costSummary: null,
        queueSnapshot: null,
        pendingQueuedMessages: [],
    };
}
function isApprovalPhase(phase) {
    return phase.kind === 'processing_awaiting_approval' || phase.kind === 'awaiting_approval';
}
function isProcessingPhase(phase) {
    return phase.kind === 'processing' || phase.kind === 'processing_awaiting_approval';
}
function getAskUserState(interaction) {
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
function toPromptInteraction(interaction) {
    const { askUserAnswers, currentAskUserQuestionIndex } = getAskUserState(interaction);
    return { kind: 'prompt', askUserAnswers, currentAskUserQuestionIndex };
}
function withInteraction(phase, interaction) {
    if (!isApprovalPhase(phase)) {
        return phase;
    }
    return { ...phase, interaction };
}
function createApprovalInteraction(approval) {
    if (approval.toolName === 'ask_user') {
        return { kind: 'prompt', askUserAnswers: [], currentAskUserQuestionIndex: 0 };
    }
    return { kind: 'prompt' };
}
function createApprovalPhase(current, approval) {
    const interaction = createApprovalInteraction(approval);
    return isProcessingPhase(current)
        ? { kind: 'processing_awaiting_approval', approval, interaction }
        : { kind: 'awaiting_approval', approval, interaction };
}
const QUEUE_ACTIVE_KINDS = new Set([
    'running',
    'awaiting_active_action',
    'cancelling',
    'completing',
]);
export function getConversationUIFlags(state) {
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
            waitingForAskUserAnswer: projected.approval.toolName === 'ask_user' && state.composerEntryMode === 'ask_user_answer',
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
export function conversationUIReducer(state, action) {
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
                retryCountdown: null,
                toolCallStreamingInfo: null,
                liveStreamingSpeed: null,
            };
        case 'turn/completed': {
            const nextPhase = state.turnPhase.kind === 'processing'
                ? { kind: 'idle' }
                : state.turnPhase.kind === 'processing_awaiting_approval'
                    ? {
                        kind: 'awaiting_approval',
                        approval: state.turnPhase.approval,
                        interaction: state.turnPhase.interaction,
                    }
                    : state.turnPhase;
            return {
                ...state,
                turnPhase: nextPhase,
                thinkingStartedAt: null,
                retryCountdown: null,
                liveStreamingSpeed: null,
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
        case 'streaming/retry_countdown':
            // Cleared on every streamed delta; skip the re-render when there is nothing to clear.
            if (action.countdown === null && state.retryCountdown === null)
                return state;
            return { ...state, retryCountdown: action.countdown };
        case 'streaming/tool_info':
            return { ...state, toolCallStreamingInfo: action.info };
        case 'streaming/speed_updated':
            return { ...state, liveStreamingSpeed: action.speed };
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
                composerEntryMode: 'none',
            };
        case 'interaction/snapshot': {
            const sameInteractionQuestion = action.snapshot !== null &&
                state.pendingInteraction?.interactionId === action.snapshot.interactionId &&
                state.pendingInteraction?.currentAskUserQuestionIndex === action.snapshot.currentAskUserQuestionIndex;
            return {
                ...state,
                pendingInteraction: action.snapshot,
                composerEntryMode: sameInteractionQuestion ? state.composerEntryMode : 'none',
            };
        }
        case 'interaction/composer_entry':
            if (!state.pendingInteraction)
                return state;
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
                retryCountdown: null,
                toolCallStreamingInfo: null,
            };
        case 'max_turns/declined':
            return {
                ...state,
                turnPhase: { kind: 'idle' },
                thinkingStartedAt: null,
                retryCountdown: null,
                toolCallStreamingInfo: null,
            };
        // --- Usage ---
        case 'usage/updated':
            return { ...state, lastUsage: action.usage };
        case 'usage/cleared':
            return { ...state, lastUsage: null };
        case 'cost/updated':
            return { ...state, costSummary: action.summary };
        case 'run_budget/noticed':
            return { ...state, runBudgetNotice: action.event };
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
                    {
                        id: action.id,
                        turn: action.turn,
                        text: formatUserTurnForDisplay(action.turn),
                        delivery: action.delivery,
                        queuedAt: action.queuedAt,
                    },
                ],
            };
        case 'queue/message_reclassified':
            if (!state.pendingQueuedMessages.some((m) => m.id === action.id)) {
                return state;
            }
            return {
                ...state,
                pendingQueuedMessages: state.pendingQueuedMessages.map((m) => m.id === action.id ? { ...m, delivery: action.delivery } : m),
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
                pendingQueuedMessages: state.pendingQueuedMessages.map((m) => m.id === action.id ? { ...m, turn: action.turn, text: formatUserTurnForDisplay(action.turn) } : m),
            };
        // --- Compound resets ---
        case 'reset_transient':
            return {
                ...state,
                turnPhase: { kind: 'idle' },
                pendingInteraction: null,
                composerEntryMode: 'none',
                thinkingStartedAt: null,
                retryCountdown: null,
                toolCallStreamingInfo: null,
                liveStreamingSpeed: null,
                queueSnapshot: null,
            };
        case 'reset_all':
            return {
                ...createInitialUIState(null),
                ...(action.preserveQueued
                    ? { pendingQueuedMessages: state.pendingQueuedMessages, queueSnapshot: state.queueSnapshot }
                    : {}),
            };
    }
}
//# sourceMappingURL=conversation-ui-reducer.js.map