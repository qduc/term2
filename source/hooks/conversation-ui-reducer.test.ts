import test from 'ava';

import type { PendingApproval } from '../contracts/conversation.js';
import { conversationUIReducer, createInitialUIState, type ConversationUIState } from './conversation-ui-reducer.js';

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

test('createInitialUIState returns all defaults', (t) => {
  const state = createInitialUIState(null);
  t.is(state.isProcessing, false);
  t.is(state.thinkingStartedAt, null);
  t.is(state.toolCallStreamingInfo, null);
  t.is(state.waitingForApproval, false);
  t.is(state.pendingApproval, null);
  t.is(state.askUserAnswers.length, 0);
  t.is(state.lastUsage, null);
  t.is(state.lastCodexRateLimit, null);
});

test('createInitialUIState preserves initial usage', (t) => {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const state = createInitialUIState(usage);
  t.deepEqual(state.lastUsage, usage);
});

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

test('turn/started sets processing and clears indicators', (t) => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    isProcessing: false,
    thinkingStartedAt: 1000,
    toolCallStreamingInfo: { toolName: 'shell', argumentCharCount: 5 },
  };
  const next = conversationUIReducer(prev, { type: 'turn/started' });
  t.is(next.isProcessing, true);
  t.is(next.thinkingStartedAt, null);
  t.is(next.toolCallStreamingInfo, null);
});

test('turn/completed clears processing and thinking', (t) => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    isProcessing: true,
    thinkingStartedAt: 2000,
  };
  const next = conversationUIReducer(prev, { type: 'turn/completed' });
  t.is(next.isProcessing, false);
  t.is(next.thinkingStartedAt, null);
});

// ---------------------------------------------------------------------------
// Streaming indicators
// ---------------------------------------------------------------------------

test('streaming/thinking_started sets timestamp on first call', (t) => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, { type: 'streaming/thinking_started', timestamp: 1000 });
  t.is(next.thinkingStartedAt, 1000);
});

test('streaming/thinking_started preserves existing timestamp', (t) => {
  const prev: ConversationUIState = { ...createInitialUIState(null), thinkingStartedAt: 500 };
  const next = conversationUIReducer(prev, { type: 'streaming/thinking_started', timestamp: 1000 });
  t.is(next.thinkingStartedAt, 500);
});

test('streaming/thinking_cleared resets timestamp', (t) => {
  const prev: ConversationUIState = { ...createInitialUIState(null), thinkingStartedAt: 500 };
  const next = conversationUIReducer(prev, { type: 'streaming/thinking_cleared' });
  t.is(next.thinkingStartedAt, null);
});

test('streaming/tool_info sets info', (t) => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, {
    type: 'streaming/tool_info',
    info: { toolName: 'shell', argumentCharCount: 10 },
  });
  t.deepEqual(next.toolCallStreamingInfo, { toolName: 'shell', argumentCharCount: 10 });
});

test('streaming/tool_info null clears info', (t) => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    toolCallStreamingInfo: { toolName: 'shell', argumentCharCount: 10 },
  };
  const next = conversationUIReducer(prev, { type: 'streaming/tool_info', info: null });
  t.is(next.toolCallStreamingInfo, null);
});

// ---------------------------------------------------------------------------
// Approval flow
// ---------------------------------------------------------------------------

test('approval/requested sets approval state', (t) => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, {
    type: 'approval/requested',
    approval: approvalFixture,
  });
  t.is(next.waitingForApproval, true);
  t.deepEqual(next.pendingApproval, approvalFixture);
  t.is(next.waitingForAskUserAnswer, false);
});

test('approval/requested for ask_user resets ask_user state', (t) => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    askUserAnswers: ['old'],
    currentAskUserQuestionIndex: 5,
    waitingForAskUserAnswer: true,
  };
  const next = conversationUIReducer(prev, {
    type: 'approval/requested',
    approval: askUserApprovalFixture,
  });
  t.deepEqual(next.askUserAnswers, []);
  t.is(next.currentAskUserQuestionIndex, 0);
});

test('approval/resolved clears all approval state', (t) => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    waitingForApproval: true,
    pendingApproval: approvalFixture,
    waitingForAskUserAnswer: true,
    askUserAnswers: ['a'],
    currentAskUserQuestionIndex: 1,
  };
  const next = conversationUIReducer(prev, { type: 'approval/resolved' });
  t.is(next.waitingForApproval, false);
  t.is(next.pendingApproval, null);
  t.is(next.waitingForAskUserAnswer, false);
  t.deepEqual(next.askUserAnswers, []);
  t.is(next.currentAskUserQuestionIndex, 0);
});

// ---------------------------------------------------------------------------
// Ask user sub-flow
// ---------------------------------------------------------------------------

test('ask_user/set_waiting enables waiting', (t) => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, { type: 'ask_user/set_waiting' });
  t.is(next.waitingForAskUserAnswer, true);
});

test('ask_user/answer_submitted appends answer', (t) => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    askUserAnswers: ['first'],
  };
  const next = conversationUIReducer(prev, { type: 'ask_user/answer_submitted', answer: 'second' });
  t.deepEqual(next.askUserAnswers, ['first', 'second']);
});

test('ask_user/advance_to_next updates index and clears waiting', (t) => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    currentAskUserQuestionIndex: 0,
    waitingForAskUserAnswer: true,
  };
  const next = conversationUIReducer(prev, { type: 'ask_user/advance_to_next', nextIndex: 1 });
  t.is(next.currentAskUserQuestionIndex, 1);
  t.is(next.waitingForAskUserAnswer, false);
});

// ---------------------------------------------------------------------------
// Max turns
// ---------------------------------------------------------------------------

test('max_turns/approved clears approval and starts processing', (t) => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    waitingForApproval: true,
    pendingApproval: { ...approvalFixture, isMaxTurnsPrompt: true },
  };
  const next = conversationUIReducer(prev, { type: 'max_turns/approved' });
  t.is(next.isProcessing, true);
  t.is(next.waitingForApproval, false);
  t.is(next.pendingApproval, null);
});

test('max_turns/declined clears approval without starting processing', (t) => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    waitingForApproval: true,
    pendingApproval: { ...approvalFixture, isMaxTurnsPrompt: true },
  };
  const next = conversationUIReducer(prev, { type: 'max_turns/declined' });
  t.is(next.isProcessing, false);
  t.is(next.waitingForApproval, false);
  t.is(next.pendingApproval, null);
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

test('usage/updated sets usage', (t) => {
  const state = createInitialUIState(null);
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const next = conversationUIReducer(state, { type: 'usage/updated', usage });
  t.deepEqual(next.lastUsage, usage);
});

test('usage/cleared resets usage', (t) => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    lastUsage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const next = conversationUIReducer(prev, { type: 'usage/cleared' });
  t.is(next.lastUsage, null);
});

test('rate_limit/updated sets rate limit', (t) => {
  const state = createInitialUIState(null);
  const rateLimit = { allowed: false, limit_reached: true };
  const next = conversationUIReducer(state, { type: 'rate_limit/updated', rateLimit });
  t.deepEqual(next.lastCodexRateLimit, rateLimit);
});

test('rate_limit/cleared resets rate limit', (t) => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    lastCodexRateLimit: { allowed: true, limit_reached: false },
  };
  const next = conversationUIReducer(prev, { type: 'rate_limit/cleared' });
  t.is(next.lastCodexRateLimit, null);
});

// ---------------------------------------------------------------------------
// Compound resets
// ---------------------------------------------------------------------------

test('reset_transient clears all transient state but preserves usage', (t) => {
  const prev: ConversationUIState = {
    isProcessing: true,
    thinkingStartedAt: 1000,
    toolCallStreamingInfo: { toolName: 'shell', argumentCharCount: 5 },
    waitingForApproval: true,
    pendingApproval: approvalFixture,
    waitingForRejectionReason: true,
    waitingForAskUserAnswer: true,
    askUserAnswers: ['a'],
    currentAskUserQuestionIndex: 1,
    lastUsage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    lastCodexRateLimit: { allowed: true, limit_reached: false },
  };
  const next = conversationUIReducer(prev, { type: 'reset_transient' });
  t.is(next.isProcessing, false);
  t.is(next.thinkingStartedAt, null);
  t.is(next.toolCallStreamingInfo, null);
  t.is(next.waitingForApproval, false);
  t.is(next.pendingApproval, null);
  t.is(next.waitingForRejectionReason, false);
  t.is(next.waitingForAskUserAnswer, false);
  t.deepEqual(next.askUserAnswers, []);
  t.is(next.currentAskUserQuestionIndex, 0);
  // Usage preserved
  t.deepEqual(next.lastUsage, prev.lastUsage);
  t.deepEqual(next.lastCodexRateLimit, prev.lastCodexRateLimit);
});

test('reset_all clears everything including usage', (t) => {
  const prev: ConversationUIState = {
    isProcessing: true,
    thinkingStartedAt: 1000,
    toolCallStreamingInfo: { toolName: 'shell', argumentCharCount: 5 },
    waitingForApproval: true,
    pendingApproval: approvalFixture,
    waitingForRejectionReason: true,
    waitingForAskUserAnswer: true,
    askUserAnswers: ['a'],
    currentAskUserQuestionIndex: 1,
    lastUsage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    lastCodexRateLimit: { allowed: true, limit_reached: false },
  };
  const next = conversationUIReducer(prev, { type: 'reset_all' });
  t.is(next.isProcessing, false);
  t.is(next.thinkingStartedAt, null);
  t.is(next.toolCallStreamingInfo, null);
  t.is(next.waitingForApproval, false);
  t.is(next.pendingApproval, null);
  t.is(next.lastUsage, null);
  t.is(next.lastCodexRateLimit, null);
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

test('reducer returns new object references', (t) => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, { type: 'turn/started' });
  t.not(state, next);
});
