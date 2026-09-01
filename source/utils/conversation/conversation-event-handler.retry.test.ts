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
