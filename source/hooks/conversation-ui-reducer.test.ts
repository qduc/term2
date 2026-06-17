import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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

it('createInitialUIState returns all defaults', () => {
  const state = createInitialUIState(null);
  expect(state.isProcessing).toBe(false);
  expect(state.thinkingStartedAt).toBe(null);
  expect(state.toolCallStreamingInfo).toBe(null);
  expect(state.waitingForApproval).toBe(false);
  expect(state.pendingApproval).toBe(null);
  expect(state.askUserAnswers.length).toBe(0);
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
    isProcessing: false,
    thinkingStartedAt: 1000,
    toolCallStreamingInfo: { toolName: 'shell', argumentCharCount: 5 },
  };
  const next = conversationUIReducer(prev, { type: 'turn/started' });
  expect(next.isProcessing).toBe(true);
  expect(next.thinkingStartedAt).toBe(null);
  expect(next.toolCallStreamingInfo).toBe(null);
});

it('turn/completed clears processing and thinking', () => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    isProcessing: true,
    thinkingStartedAt: 2000,
  };
  const next = conversationUIReducer(prev, { type: 'turn/completed' });
  expect(next.isProcessing).toBe(false);
  expect(next.thinkingStartedAt).toBe(null);
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
  expect(next.waitingForApproval).toBe(true);
  expect(next.pendingApproval).toEqual(approvalFixture);
  expect(next.waitingForAskUserAnswer).toBe(false);
});

it('approval/requested for ask_user resets ask_user state', () => {
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
  expect(next.askUserAnswers).toEqual([]);
  expect(next.currentAskUserQuestionIndex).toBe(0);
});

it('approval/resolved clears all approval state', () => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    waitingForApproval: true,
    pendingApproval: approvalFixture,
    waitingForAskUserAnswer: true,
    askUserAnswers: ['a'],
    currentAskUserQuestionIndex: 1,
  };
  const next = conversationUIReducer(prev, { type: 'approval/resolved' });
  expect(next.waitingForApproval).toBe(false);
  expect(next.pendingApproval).toBe(null);
  expect(next.waitingForAskUserAnswer).toBe(false);
  expect(next.askUserAnswers).toEqual([]);
  expect(next.currentAskUserQuestionIndex).toBe(0);
});

// ---------------------------------------------------------------------------
// Ask user sub-flow
// ---------------------------------------------------------------------------

it('ask_user/set_waiting enables waiting', () => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, { type: 'ask_user/set_waiting' });
  expect(next.waitingForAskUserAnswer).toBe(true);
});

it('ask_user/answer_submitted appends answer', () => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    askUserAnswers: ['first'],
  };
  const next = conversationUIReducer(prev, { type: 'ask_user/answer_submitted', answer: 'second' });
  expect(next.askUserAnswers).toEqual(['first', 'second']);
});

it('ask_user/advance_to_next updates index and clears waiting', () => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    currentAskUserQuestionIndex: 0,
    waitingForAskUserAnswer: true,
  };
  const next = conversationUIReducer(prev, { type: 'ask_user/advance_to_next', nextIndex: 1 });
  expect(next.currentAskUserQuestionIndex).toBe(1);
  expect(next.waitingForAskUserAnswer).toBe(false);
});

// ---------------------------------------------------------------------------
// Max turns
// ---------------------------------------------------------------------------

it('max_turns/approved clears approval and starts processing', () => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    waitingForApproval: true,
    pendingApproval: { ...approvalFixture, isMaxTurnsPrompt: true },
  };
  const next = conversationUIReducer(prev, { type: 'max_turns/approved' });
  expect(next.isProcessing).toBe(true);
  expect(next.waitingForApproval).toBe(false);
  expect(next.pendingApproval).toBe(null);
});

it('max_turns/declined clears approval without starting processing', () => {
  const prev: ConversationUIState = {
    ...createInitialUIState(null),
    waitingForApproval: true,
    pendingApproval: { ...approvalFixture, isMaxTurnsPrompt: true },
  };
  const next = conversationUIReducer(prev, { type: 'max_turns/declined' });
  expect(next.isProcessing).toBe(false);
  expect(next.waitingForApproval).toBe(false);
  expect(next.pendingApproval).toBe(null);
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
  expect(next.isProcessing).toBe(false);
  expect(next.thinkingStartedAt).toBe(null);
  expect(next.toolCallStreamingInfo).toBe(null);
  expect(next.waitingForApproval).toBe(false);
  expect(next.pendingApproval).toBe(null);
  expect(next.waitingForRejectionReason).toBe(false);
  expect(next.waitingForAskUserAnswer).toBe(false);
  expect(next.askUserAnswers).toEqual([]);
  expect(next.currentAskUserQuestionIndex).toBe(0);
  // Usage preserved
  expect(next.lastUsage).toEqual(prev.lastUsage);
  expect(next.lastCodexRateLimit).toEqual(prev.lastCodexRateLimit);
});

it('reset_all clears everything including usage', () => {
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
  expect(next.isProcessing).toBe(false);
  expect(next.thinkingStartedAt).toBe(null);
  expect(next.toolCallStreamingInfo).toBe(null);
  expect(next.waitingForApproval).toBe(false);
  expect(next.pendingApproval).toBe(null);
  expect(next.lastUsage).toBe(null);
  expect(next.lastCodexRateLimit).toBe(null);
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

it('reducer returns new object references', () => {
  const state = createInitialUIState(null);
  const next = conversationUIReducer(state, { type: 'turn/started' });
  expect(state).not.toBe(next);
});
