import { it, expect } from 'vitest';
import { createConversationEventHandler } from './conversation-event-handler.js';
import { createStreamingState } from './conversation-utils.js';
import type { ConversationEvent } from '../../services/conversation/conversation-events.js';
import { createMockDeps } from './test-helpers/event-handler-fixtures.js';

const runOne = (event: ConversationEvent) => {
  const deps = createMockDeps();
  const handler = createConversationEventHandler(deps, createStreamingState());
  handler(event);
  expect(deps.calls.appendedMessages.length).toBe(1);
  return deps.calls.appendedMessages[0]!;
};

// The system message text used to be the literal string "[Retry] [Cancel]" --
// decorative characters with no keybinding, command, or component behind
// them. This proves the message instead points at a real, working mechanism
// (the /retry-turn slash command) so a user reading it can actually retry.
it('retry_exhausted: points the user at the real /retry-turn command instead of fake buttons', () => {
  const result = runOne({
    type: 'retry_exhausted',
    provider: 'openai',
    errorKind: 'network',
    attempts: 3,
    maxAttempts: 3,
    message: 'Could not reach openai after 3 attempts. No model response was received.',
    canRetry: true,
  } as ConversationEvent);

  expect(result.length).toBe(1);
  expect(result[0].sender).toBe('system');
  expect(result[0].text).not.toContain('[Retry]');
  expect(result[0].text).not.toContain('[Cancel]');
  expect(result[0].text).toContain('Could not reach openai after 3 attempts.');
  expect(result[0].text).toContain('/retry-turn');
});

// A real provider continuity rejection (e.g. Invalid previous_response_id)
// and a recoverable WebSocket abnormal/incomplete close (e.g. code 1006) both
// classify as chain_recovery and share the same recovery mechanics, but they
// are different events and must not share a presentation: only the former is
// a provider rejection of conversation state.
it('retry: conversation_state text claims the provider rejected conversation state', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'retry',
    toolName: 'conversation',
    attempt: 1,
    maxRetries: 3,
    errorMessage: 'Invalid `previous_response_id`.',
    retryType: 'conversation_state',
  } as ConversationEvent);

  const updater = deps.calls.setMessagesCalls[0]!;
  const result = updater([]);
  expect(result[0].text).toContain('Conversation state was rejected by the provider');
});

it('retry: connection_interrupted text describes a dropped connection, not a provider rejection', () => {
  const deps = createMockDeps();
  const state = createStreamingState();
  const handler = createConversationEventHandler(deps, state);

  handler({
    type: 'retry',
    toolName: 'conversation',
    attempt: 1,
    maxRetries: 3,
    errorMessage: 'Codex WebSocket connection closed before a terminal response event. (code=1006)',
    retryType: 'connection_interrupted',
  } as ConversationEvent);

  const updater = deps.calls.setMessagesCalls[0]!;
  const result = updater([]);
  expect(result[0].text).toContain('Connection was interrupted');
  expect(result[0].text).not.toContain('rejected by the provider');
  expect(result[0].text).not.toContain('Conversation state was rejected');
});

it('retry_exhausted: does not suggest retrying when canRetry is false', () => {
  const result = runOne({
    type: 'retry_exhausted',
    provider: 'openai',
    errorKind: 'authentication',
    attempts: 1,
    maxAttempts: 3,
    message: 'Authentication failed.',
    canRetry: false,
  } as ConversationEvent);

  expect(result[0].text).toBe('Authentication failed.');
  expect(result[0].text).not.toContain('/retry-turn');
});
