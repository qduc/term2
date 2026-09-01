import { it, expect } from 'vitest';
import { isCommittedOutputEvent, type ConversationEvent } from './conversation-events.js';

// cost_update fires even for a request that produced nothing -- it can carry
// outcome: 'failed'. Treating its presence as "output was committed" blocked
// safe recovery (chain_recovery/transient) for the common case of a request
// that failed before streaming anything at all. See turn-workflow.ts's
// #consumeInitialStream, which gates TurnAttempt.markModelEventSeen on this.
it('cost_update, usage_update, and run_budget are not committed output', () => {
  expect(isCommittedOutputEvent({ type: 'cost_update' } as unknown as ConversationEvent)).toBe(false);
  expect(isCommittedOutputEvent({ type: 'usage_update' } as unknown as ConversationEvent)).toBe(false);
  expect(isCommittedOutputEvent({ type: 'run_budget' } as unknown as ConversationEvent)).toBe(false);
  expect(isCommittedOutputEvent({ type: 'context_compaction_started' } as unknown as ConversationEvent)).toBe(false);
});

it('text_delta, tool_dispatched, and final are committed output', () => {
  expect(isCommittedOutputEvent({ type: 'text_delta' } as unknown as ConversationEvent)).toBe(true);
  expect(isCommittedOutputEvent({ type: 'tool_dispatched' } as unknown as ConversationEvent)).toBe(true);
  expect(isCommittedOutputEvent({ type: 'final' } as unknown as ConversationEvent)).toBe(true);
});
