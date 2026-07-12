import { it, expect } from 'vitest';
import type { PendingApproval } from '../contracts/conversation.js';
import {
  conversationUIReducer,
  createInitialUIState,
  getConversationUIFlags,
  type ConversationUIState,
} from './conversation-ui-reducer.js';

const approvalFixture: PendingApproval = {
  agentName: 'System',
  toolName: 'shell',
  argumentsText: 'ls -la',
  rawInterruption: null,
};

const askUserApprovalFixture: PendingApproval = {
  agentName: 'System',
  toolName: 'ask_user',
  argumentsText: '{"questions":[{"question":"Pick one"}]}',
  rawInterruption: null,
};

// ---------------------------------------------------------------------------
// createInitialUIState
// ---------------------------------------------------------------------------

it('createInitialUIState returns all defaults', () => {
  const state = createInitialUIState(null);
  const flags = getConversationUIFlags(state);
  expect(flags.isProcessing).toBe(false);
  expect(state.thinkingStartedAt).toBe(null);
  expect(state.toolCallStreamingInfo).toBe(null);
  expect(flags.waitingForApproval).toBe(false);
  expect(flags.pendingApproval).toBe(null);
  expect(flags.askUserAnswers.length).toBe(0);
  expect(state.lastUsage).toBe(null);
  expect(state.lastCodexRateLimit).toBe(null);
});

it('createInitialUIState preserves initial usage', () => {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const state = createInitialUIState(usage);
  expect(state.lastUsage).toEqual(usage);
});

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

it('turn/started sets processing and clears indicators', () => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    thinkingStartedAt: 1000,
    toolCallStreamingInfo: { toolName: 'shell', argumentCharCount: 5 },
  };
  const next = conversationUIReducer(prev, { type: 'turn/started' });
  expect(getConversationUIFlags(next).isProcessing).toBe(true);
  expect(next.thinkingStartedAt).toBe(null);
  expect(next.toolCallStreamingInfo).toBe(null);
});

it('turn/completed clears processing and thinking', () => {
  const prev = {
    ...conversationUIReducer(createInitialUIState(null), { type: 'turn/started' }),
    thinkingStartedAt: 2000,
  };
  const next = conversationUIReducer(prev, { type: 'turn/completed' });
  expect(getConversationUIFlags(next).isProcessing).toBe(false);
  expect(next.thinkingStartedAt).toBe(null);
});

it('turn/completed preserves approval requested while processing', () => {
  let state = createInitialUIState(null);
  state = conversationUIReducer(state, { type: 'turn/started' });
  state = conversationUIReducer(state, { type: 'approval/requested', approval: approvalFixture });

  let flags = getConversationUIFlags(state);
  expect(flags.isProcessing).toBe(true);
  expect(flags.waitingForApproval).toBe(true);

  state = conversationUIReducer(state, { type: 'turn/completed' });

  flags = getConversationUIFlags(state);
  expect(flags.isProcessing).toBe(false);
  expect(flags.waitingForApproval).toBe(true);
  expect(flags.pendingApproval).toEqual(approvalFixture);
});

it('turn/started is ignored while already processing', () => {
  let state = createInitialUIState(null);
  state = conversationUIReducer(state, { type: 'turn/started' });
  state = conversationUIReducer(state, { type: 'streaming/thinking_started', timestamp: 1000 });
  state = conversationUIReducer(state, { type: 'turn/started' });

  const flags = getConversationUIFlags(state);
  expect(flags.isProcessing).toBe(true);
  expect(state.thinkingStartedAt).toBe(1000);
});

// ---------------------------------------------------------------------------
// Streaming indicators
// ---------------------------------------------------------------------------

it('streaming/thinking_started sets timestamp on first call', () => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, { type: 'streaming/thinking_started', timestamp: 1000 });
  expect(next.thinkingStartedAt).toBe(1000);
});

it('streaming/thinking_started preserves existing timestamp', () => {
  const prev: ConversationUIState = { ...createInitialUIState(null), thinkingStartedAt: 500 };
  const next = conversationUIReducer(prev, { type: 'streaming/thinking_started', timestamp: 1000 });
  expect(next.thinkingStartedAt).toBe(500);
});

it('streaming/thinking_cleared resets timestamp', () => {
  const prev: ConversationUIState = { ...createInitialUIState(null), thinkingStartedAt: 500 };
  const next = conversationUIReducer(prev, { type: 'streaming/thinking_cleared' });
  expect(next.thinkingStartedAt).toBe(null);
});

it('streaming/tool_info sets info', () => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, {
    type: 'streaming/tool_info',
    info: { toolName: 'shell', argumentCharCount: 10 },
  });
  expect(next.toolCallStreamingInfo).toEqual({ toolName: 'shell', argumentCharCount: 10 });
});

it('streaming/tool_info null clears info', () => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    toolCallStreamingInfo: { toolName: 'shell', argumentCharCount: 10 },
  };
  const next = conversationUIReducer(prev, { type: 'streaming/tool_info', info: null });
  expect(next.toolCallStreamingInfo).toBe(null);
});

// ---------------------------------------------------------------------------
// Approval flow
// ---------------------------------------------------------------------------

it('approval/requested sets approval state', () => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, {
    type: 'approval/requested',
    approval: approvalFixture,
  });
  const flags = getConversationUIFlags(next);
  expect(flags.waitingForApproval).toBe(true);
  expect(flags.pendingApproval).toEqual(approvalFixture);
  expect(flags.waitingForAskUserAnswer).toBe(false);
});

it('approval/requested for ask_user resets ask_user state', () => {
  let prev = conversationUIReducer(createInitialUIState(null), {
    type: 'approval/requested',
    approval: askUserApprovalFixture,
  });
  prev = conversationUIReducer(prev, { type: 'ask_user/answer_submitted', answer: 'old' });
  prev = conversationUIReducer(prev, { type: 'ask_user/advance_to_next', nextIndex: 5 });
  prev = conversationUIReducer(prev, { type: 'ask_user/set_waiting' });
  const next = conversationUIReducer(prev, {
    type: 'approval/requested',
    approval: askUserApprovalFixture,
  });
  const flags = getConversationUIFlags(next);
  expect(flags.askUserAnswers).toEqual([]);
  expect(flags.currentAskUserQuestionIndex).toBe(0);
});

it('approval/resolved clears all approval state', () => {
  let prev = conversationUIReducer(createInitialUIState(null), {
    type: 'approval/requested',
    approval: askUserApprovalFixture,
  });
  prev = conversationUIReducer(prev, { type: 'ask_user/answer_submitted', answer: 'a' });
  prev = conversationUIReducer(prev, { type: 'ask_user/advance_to_next', nextIndex: 1 });
  prev = conversationUIReducer(prev, { type: 'ask_user/set_waiting' });
  const next = conversationUIReducer(prev, { type: 'approval/resolved' });
  const flags = getConversationUIFlags(next);
  expect(flags.waitingForApproval).toBe(false);
  expect(flags.pendingApproval).toBe(null);
  expect(flags.waitingForAskUserAnswer).toBe(false);
  expect(flags.askUserAnswers).toEqual([]);
  expect(flags.currentAskUserQuestionIndex).toBe(0);
});

it('ask_user/set_waiting is ignored without an active ask_user approval', () => {
  let state = createInitialUIState(null);
  state = conversationUIReducer(state, { type: 'ask_user/set_waiting' });
  expect(getConversationUIFlags(state).waitingForAskUserAnswer).toBe(false);

  state = conversationUIReducer(state, { type: 'approval/requested', approval: approvalFixture });
  state = conversationUIReducer(state, { type: 'ask_user/set_waiting' });
  expect(getConversationUIFlags(state).waitingForAskUserAnswer).toBe(false);
});

it('rejection/set_waiting is ignored without an active approval', () => {
  let state = createInitialUIState(null);
  state = conversationUIReducer(state, { type: 'rejection/set_waiting' });
  expect(getConversationUIFlags(state).waitingForRejectionReason).toBe(false);
});

// ---------------------------------------------------------------------------
// Ask user sub-flow
// ---------------------------------------------------------------------------

it('ask_user/set_waiting enables waiting', () => {
  const state = conversationUIReducer(createInitialUIState(null), {
    type: 'approval/requested',
    approval: askUserApprovalFixture,
  });
  const next = conversationUIReducer(state, { type: 'ask_user/set_waiting' });
  expect(getConversationUIFlags(next).waitingForAskUserAnswer).toBe(true);
});

it('ask_user/answer_submitted appends answer', () => {
  let prev = conversationUIReducer(createInitialUIState(null), {
    type: 'approval/requested',
    approval: askUserApprovalFixture,
  });
  prev = conversationUIReducer(prev, { type: 'ask_user/answer_submitted', answer: 'first' });
  const next = conversationUIReducer(prev, { type: 'ask_user/answer_submitted', answer: 'second' });
  expect(getConversationUIFlags(next).askUserAnswers).toEqual(['first', 'second']);
});

it('ask_user/advance_to_next updates index and clears waiting', () => {
  let prev = conversationUIReducer(createInitialUIState(null), {
    type: 'approval/requested',
    approval: askUserApprovalFixture,
  });
  prev = conversationUIReducer(prev, { type: 'ask_user/set_waiting' });
  const next = conversationUIReducer(prev, { type: 'ask_user/advance_to_next', nextIndex: 1 });
  const flags = getConversationUIFlags(next);
  expect(flags.currentAskUserQuestionIndex).toBe(1);
  expect(flags.waitingForAskUserAnswer).toBe(false);
});

// ---------------------------------------------------------------------------
// Max turns
// ---------------------------------------------------------------------------

it('max_turns/approved clears approval and starts processing', () => {
  const prev = conversationUIReducer(createInitialUIState(null), {
    type: 'approval/requested',
    approval: { ...approvalFixture, isMaxTurnsPrompt: true },
  });
  const next = conversationUIReducer(prev, { type: 'max_turns/approved' });
  const flags = getConversationUIFlags(next);
  expect(flags.isProcessing).toBe(true);
  expect(flags.waitingForApproval).toBe(false);
  expect(flags.pendingApproval).toBe(null);
});

it('max_turns/declined clears approval without starting processing', () => {
  const prev = conversationUIReducer(createInitialUIState(null), {
    type: 'approval/requested',
    approval: { ...approvalFixture, isMaxTurnsPrompt: true },
  });
  const next = conversationUIReducer(prev, { type: 'max_turns/declined' });
  const flags = getConversationUIFlags(next);
  expect(flags.isProcessing).toBe(false);
  expect(flags.waitingForApproval).toBe(false);
  expect(flags.pendingApproval).toBe(null);
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

it('usage/updated sets usage', () => {
  const state = createInitialUIState(null);
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const next = conversationUIReducer(state, { type: 'usage/updated', usage });
  expect(next.lastUsage).toEqual(usage);
});

it('usage/cleared resets usage', () => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    lastUsage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const next = conversationUIReducer(prev, { type: 'usage/cleared' });
  expect(next.lastUsage).toBe(null);
});

it('rate_limit/updated sets rate limit', () => {
  const state = createInitialUIState(null);
  const rateLimit = { allowed: false, limit_reached: true };
  const next = conversationUIReducer(state, { type: 'rate_limit/updated', rateLimit });
  expect(next.lastCodexRateLimit).toEqual(rateLimit);
});

it('rate_limit/cleared resets rate limit', () => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    lastCodexRateLimit: { allowed: true, limit_reached: false },
  };
  const next = conversationUIReducer(prev, { type: 'rate_limit/cleared' });
  expect(next.lastCodexRateLimit).toBe(null);
});

// ---------------------------------------------------------------------------
// Compound resets
// ---------------------------------------------------------------------------

it('reset_transient clears all transient state but preserves usage', () => {
  let prev: ConversationUIState = {
    ...createInitialUIState({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    thinkingStartedAt: 1000,
    toolCallStreamingInfo: { toolName: 'shell', argumentCharCount: 5 },
    lastCodexRateLimit: { allowed: true, limit_reached: false },
  };
  prev = conversationUIReducer(prev, { type: 'turn/started' });
  prev = conversationUIReducer(prev, { type: 'approval/requested', approval: askUserApprovalFixture });
  prev = conversationUIReducer(prev, { type: 'ask_user/answer_submitted', answer: 'a' });
  prev = conversationUIReducer(prev, { type: 'ask_user/advance_to_next', nextIndex: 1 });
  prev = conversationUIReducer(prev, { type: 'ask_user/set_waiting' });
  const next = conversationUIReducer(prev, { type: 'reset_transient' });
  const flags = getConversationUIFlags(next);
  expect(flags.isProcessing).toBe(false);
  expect(next.thinkingStartedAt).toBe(null);
  expect(next.toolCallStreamingInfo).toBe(null);
  expect(flags.waitingForApproval).toBe(false);
  expect(flags.pendingApproval).toBe(null);
  expect(flags.waitingForRejectionReason).toBe(false);
  expect(flags.waitingForAskUserAnswer).toBe(false);
  expect(flags.askUserAnswers).toEqual([]);
  expect(flags.currentAskUserQuestionIndex).toBe(0);
  // Usage preserved
  expect(next.lastUsage).toEqual(prev.lastUsage);
  expect(next.lastCodexRateLimit).toEqual(prev.lastCodexRateLimit);
});

it('reset_all clears everything including usage', () => {
  const prev: ConversationUIState = {
    ...createInitialUIState({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    thinkingStartedAt: 1000,
    toolCallStreamingInfo: { toolName: 'shell', argumentCharCount: 5 },
    lastCodexRateLimit: { allowed: true, limit_reached: false },
  };
  const next = conversationUIReducer(prev, { type: 'reset_all' });
  const flags = getConversationUIFlags(next);
  expect(flags.isProcessing).toBe(false);
  expect(next.thinkingStartedAt).toBe(null);
  expect(next.toolCallStreamingInfo).toBe(null);
  expect(flags.waitingForApproval).toBe(false);
  expect(flags.pendingApproval).toBe(null);
  expect(next.lastUsage).toBe(null);
  expect(next.lastCodexRateLimit).toBe(null);
});

// ---------------------------------------------------------------------------
// Queue state
// ---------------------------------------------------------------------------

it('queue/updated sets queue state and flags derive queueActive', () => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, {
    type: 'queue/updated',
    snapshot: { queueLength: 2, stateKind: 'running' },
  });
  const flags = getConversationUIFlags(next);
  expect(flags.queueActive).toBe(true);
  expect(flags.queuePaused).toBe(false);
  expect(flags.isProcessing).toBe(true);
  expect(flags.queueLength).toBe(2);
});

it('queue/updated with paused state sets queuePaused', () => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, {
    type: 'queue/updated',
    snapshot: { queueLength: 3, stateKind: 'paused', pauseReason: 'failure' },
  });
  const flags = getConversationUIFlags(next);
  expect(flags.queueActive).toBe(false);
  expect(flags.queuePaused).toBe(true);
  expect(flags.isProcessing).toBe(false);
  expect(flags.queueLength).toBe(3);
  expect(flags.queuePauseReason).toBe('failure');
});

it('queue/updated with idle state clears queue flags', () => {
  let state = conversationUIReducer(createInitialUIState(null), {
    type: 'queue/updated',
    snapshot: { queueLength: 2, stateKind: 'running' },
  });
  state = conversationUIReducer(state, {
    type: 'queue/updated',
    snapshot: { queueLength: 0, stateKind: 'idle' },
  });
  const flags = getConversationUIFlags(state);
  expect(flags.queueActive).toBe(false);
  expect(flags.queuePaused).toBe(false);
  expect(flags.isProcessing).toBe(false);
  expect(flags.queueLength).toBe(0);
});

it('isProcessing stays true when queue is active even after turn/completed', () => {
  let state = createInitialUIState(null);
  // Simulate: turn starts, queue becomes active, turn completes (queued successor)
  state = conversationUIReducer(state, { type: 'turn/started' });
  state = conversationUIReducer(state, {
    type: 'queue/updated',
    snapshot: { queueLength: 1, stateKind: 'running' },
  });
  state = conversationUIReducer(state, { type: 'turn/completed' });
  // Queue is still active, so isProcessing should remain true
  const flags = getConversationUIFlags(state);
  expect(flags.isProcessing).toBe(true);
  expect(flags.queueActive).toBe(true);
});

it('queue/updated with completing also counts as queueActive', () => {
  const state = conversationUIReducer(createInitialUIState(null), {
    type: 'queue/updated',
    snapshot: { queueLength: 1, stateKind: 'completing' },
  });
  const flags = getConversationUIFlags(state);
  expect(flags.queueActive).toBe(true);
  expect(flags.isProcessing).toBe(true);
});

it('queue/updated with cancelling also counts as queueActive', () => {
  const state = conversationUIReducer(createInitialUIState(null), {
    type: 'queue/updated',
    snapshot: { queueLength: 0, stateKind: 'cancelling' },
  });
  const flags = getConversationUIFlags(state);
  expect(flags.queueActive).toBe(true);
  expect(flags.isProcessing).toBe(true);
});

it('queue/updated with awaiting_active_action also counts as queueActive', () => {
  const state = conversationUIReducer(createInitialUIState(null), {
    type: 'queue/updated',
    snapshot: { queueLength: 1, stateKind: 'awaiting_active_action' },
  });
  const flags = getConversationUIFlags(state);
  expect(flags.queueActive).toBe(true);
  expect(flags.isProcessing).toBe(true);
});

it('queue/updated with awaiting_preflight does NOT count as queueActive', () => {
  const state = conversationUIReducer(createInitialUIState(null), {
    type: 'queue/updated',
    snapshot: { queueLength: 1, stateKind: 'awaiting_preflight' },
  });
  const flags = getConversationUIFlags(state);
  expect(flags.queueActive).toBe(false);
  expect(flags.isProcessing).toBe(false);
});

it('reset_transient clears queue state', () => {
  let state = conversationUIReducer(createInitialUIState(null), {
    type: 'queue/updated',
    snapshot: { queueLength: 2, stateKind: 'running' },
  });
  state = conversationUIReducer(state, { type: 'reset_transient' });
  const flags = getConversationUIFlags(state);
  expect(flags.queueActive).toBe(false);
  expect(flags.queuePaused).toBe(false);
  expect(flags.queueLength).toBe(0);
  expect(flags.queuePauseReason).toBeUndefined();
  expect(flags.isProcessing).toBe(false);
});

it('reset_all clears queue state including usage', () => {
  let state = conversationUIReducer(createInitialUIState(null), {
    type: 'queue/updated',
    snapshot: { queueLength: 3, stateKind: 'paused', pauseReason: 'manual' },
  });
  state = conversationUIReducer(state, {
    type: 'usage/updated',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  state = conversationUIReducer(state, { type: 'reset_all' });
  const flags = getConversationUIFlags(state);
  expect(flags.queueActive).toBe(false);
  expect(flags.queuePaused).toBe(false);
  expect(flags.queueLength).toBe(0);
  expect(flags.isProcessing).toBe(false);
  expect(state.lastUsage).toBe(null);
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

it('reducer returns new object references', () => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, { type: 'turn/started' });
  expect(state).not.toBe(next);
});

// ---------------------------------------------------------------------------
// Queued messages
// ---------------------------------------------------------------------------

it('queue/message_pending appends to pendingQueuedMessages', () => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, {
    type: 'queue/message_pending',
    id: 'm-1',
    text: 'hello',
    queuedAt: 1000,
  });
  expect(next.pendingQueuedMessages).toEqual([{ id: 'm-1', text: 'hello', queuedAt: 1000 }]);
});

it('queue/message_pending accumulates multiple pending messages in order', () => {
  let state = createInitialUIState(null);
  state = conversationUIReducer(state, { type: 'queue/message_pending', id: 'm-1', text: 'first', queuedAt: 1 });
  state = conversationUIReducer(state, { type: 'queue/message_pending', id: 'm-2', text: 'second', queuedAt: 2 });
  expect(state.pendingQueuedMessages.map((m) => m.id)).toEqual(['m-1', 'm-2']);
  expect(state.pendingQueuedMessages.map((m) => m.text)).toEqual(['first', 'second']);
  expect(state.pendingQueuedMessages.map((m) => m.queuedAt)).toEqual([1, 2]);
});

it('queue/message_started removes the matching id from pendingQueuedMessages', () => {
  let state = createInitialUIState(null);
  state = conversationUIReducer(state, { type: 'queue/message_pending', id: 'm-1', text: 'first', queuedAt: 1 });
  state = conversationUIReducer(state, { type: 'queue/message_pending', id: 'm-2', text: 'second', queuedAt: 2 });
  const next = conversationUIReducer(state, { type: 'queue/message_started', id: 'm-1' });
  expect(next.pendingQueuedMessages.map((m) => m.id)).toEqual(['m-2']);
});

it('queue/message_started preserves other pending messages', () => {
  let state = createInitialUIState(null);
  state = conversationUIReducer(state, { type: 'queue/message_pending', id: 'm-1', text: 'first', queuedAt: 1 });
  state = conversationUIReducer(state, { type: 'queue/message_pending', id: 'm-2', text: 'second', queuedAt: 2 });
  state = conversationUIReducer(state, { type: 'queue/message_pending', id: 'm-3', text: 'third', queuedAt: 3 });
  const next = conversationUIReducer(state, { type: 'queue/message_started', id: 'm-2' });
  expect(next.pendingQueuedMessages.map((m) => m.id)).toEqual(['m-1', 'm-3']);
});

it('queue/message_started is a no-op when the id is not pending', () => {
  let state = createInitialUIState(null);
  state = conversationUIReducer(state, { type: 'queue/message_pending', id: 'm-1', text: 'first', queuedAt: 1 });
  const next = conversationUIReducer(state, { type: 'queue/message_started', id: 'unknown' });
  expect(next.pendingQueuedMessages.map((m) => m.id)).toEqual(['m-1']);
});

it('queue/remove_last_pending removes the last entry from pendingQueuedMessages', () => {
  let state = createInitialUIState(null);
  state = conversationUIReducer(state, { type: 'queue/message_pending', id: 'm-1', text: 'first', queuedAt: 1 });
  state = conversationUIReducer(state, { type: 'queue/message_pending', id: 'm-2', text: 'second', queuedAt: 2 });
  state = conversationUIReducer(state, { type: 'queue/message_pending', id: 'm-3', text: 'third', queuedAt: 3 });
  const next = conversationUIReducer(state, { type: 'queue/remove_last_pending' });
  expect(next.pendingQueuedMessages.map((m) => m.id)).toEqual(['m-1', 'm-2']);
  expect(next.pendingQueuedMessages.map((m) => m.text)).toEqual(['first', 'second']);
});

it('queue/remove_last_pending is a no-op when pendingQueuedMessages is empty', () => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, { type: 'queue/remove_last_pending' });
  expect(next.pendingQueuedMessages).toEqual([]);
  // Reference equality is required because there is nothing to change.
  expect(next).toBe(state);
});

it('queue/remove_last_pending removes the single entry when only one is pending', () => {
  let state = createInitialUIState(null);
  state = conversationUIReducer(state, { type: 'queue/message_pending', id: 'm-1', text: 'only', queuedAt: 1 });
  const next = conversationUIReducer(state, { type: 'queue/remove_last_pending' });
  expect(next.pendingQueuedMessages).toEqual([]);
});

it('reset_all clears pendingQueuedMessages', () => {
  let state = createInitialUIState(null);
  state = conversationUIReducer(state, { type: 'queue/message_pending', id: 'm-1', text: 'first', queuedAt: 1 });
  const next = conversationUIReducer(state, { type: 'reset_all' });
  expect(next.pendingQueuedMessages).toEqual([]);
});
