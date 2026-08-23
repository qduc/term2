import { it, expect, vi } from 'vitest';
import { ConversationStore } from '../conversation/conversation-store.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { SessionLifecycle } from './session-lifecycle.js';
import { AssistantTurnJournal } from '../logging/assistant-turn-journal.js';
import { DefaultRecoveryExecutor } from '../retry/recovery-executor.js';
import { ProviderContinuity } from '../provider-continuity.js';
import type { AgentStream } from '../agent-stream.js';

/**
 * Regression test for the 2026-08-23 incident: after the user undid turns and
 * retried, the failure-recovery path rebuilt the tool ledger from the
 * session-wide assistant journal — which still held the undone turns' tool
 * items — and re-injected those pairs into provider history. A single turn
 * then carried the tool results of every previously-undone run (55 items,
 * 45k tokens → 400 from the provider).
 *
 * The undo path pruned the store and the live ledger, but not the journal.
 */

const recordToolPair = (
  journal: AssistantTurnJournal,
  tracker: SessionToolTracker,
  callId: string,
  output: string,
): void => {
  const call = {
    type: 'function_call',
    callId,
    name: 'shell',
    arguments: JSON.stringify({ command: `cmd-${callId}` }),
  };
  const result = { type: 'function_call_result', callId, name: 'shell', output };
  journal.recordRunItem({ rawItem: call });
  tracker.recordFunctionCall(call);
  journal.recordRunItem({ rawItem: result });
  tracker.recordFunctionResult(result);
};

const callIdsIn = (history: readonly unknown[]): string[] => {
  const ids: string[] = [];
  for (const item of history) {
    const record = item as Record<string, unknown>;
    const callId = record?.callId ?? (record?.call_id as string | undefined);
    if (typeof callId === 'string') ids.push(callId);
  }
  return ids;
};

const makeLifecycle = (deps: {
  store: ConversationStore;
  tracker: SessionToolTracker;
  journal: AssistantTurnJournal;
}): SessionLifecycle =>
  new SessionLifecycle({
    inputPlanner: { markUndoOrRewind: vi.fn(), markResumedSession: vi.fn(), reset: vi.fn() } as any,
    toolTracker: deps.tracker,
    conversationStore: deps.store,
    journal: deps.journal,
    logger: { warn: vi.fn() } as any,
    sessionId: 'session-test',
    appState: { statusMachine: { abort: vi.fn() } } as any,
    providerContinuity: { clear: vi.fn(), update: vi.fn() } as any,
    generationGuard: { invalidate: vi.fn() } as any,
    continuityReset: { reset: vi.fn() } as any,
  });

it('undo keeps undone turns out of the assistant journal used by failure recovery', () => {
  const store = new ConversationStore();
  const tracker = new SessionToolTracker(store);
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => tracker.getCurrentTurnId() });
  const lifecycle = makeLifecycle({ store, tracker, journal });

  // Turn 1 (later undone): one completed tool pair.
  store.addUserMessage('debug wifi issue');
  tracker.beginTurn(); // turn-1
  recordToolPair(journal, tracker, 'call_old_1', 'old result 1');

  // Turn 2 (later undone): one completed tool pair.
  store.addUserMessage('do both');
  tracker.beginTurn(); // turn-2
  recordToolPair(journal, tracker, 'call_old_2', 'old result 2');

  // The undo path removes both user turns from the store, prunes the live
  // ledger, and must also drop the undone turns' buffered journal items.
  store.removeNLastUserTurns(2);
  lifecycle.afterUndo();

  // New turn after the undo: a fresh pair with fresh call ids.
  store.addUserMessage('debug wifi issue');
  tracker.beginTurn(); // turn numbering restarts; ids must be unambiguous post-prune
  recordToolPair(journal, tracker, 'call_new_1', 'new result 1');
  recordToolPair(journal, tracker, 'call_new_2', 'new result 2');

  // The journal snapshot handed to failure recovery must not contain the
  // undone turns' items.
  const journalCallIds = journal.getEvents().map((event) => {
    const item = event.item as { callId?: string };
    return item.callId;
  });
  expect(journalCallIds).not.toContain('call_old_1');
  expect(journalCallIds).not.toContain('call_old_2');

  // A mid-turn stream failure now runs the retry_fresh recovery, which
  // rebuilds the ledger from the journal snapshot and projects it back into
  // the store. Only the current turn's pairs may land in history.
  const executor = new DefaultRecoveryExecutor({
    toolTracker: tracker,
    conversationStore: store,
    providerContinuity: new ProviderContinuity(),
  });
  executor.apply({
    plan: { kind: 'retry_fresh', inputMode: 'full_history' },
    state: {
      journalSnapshot: journal.getEvents(),
      addedUserMessage: false,
      stream: {} as AgentStream,
    },
    retryCounts: {
      transientRetryCount: 1,
      serviceTierFallbackCount: 0,
      modelRetryCount: 0,
      transportDowngradeCount: 0,
    },
    maxModelRetries: 3,
  });

  const ids = callIdsIn(store.getHistory());
  expect(ids).not.toContain('call_old_1');
  expect(ids).not.toContain('call_old_2');
  expect(ids).toContain('call_new_1');
  expect(ids).toContain('call_new_2');
  // Each call id appears exactly as one call/result pair — never replayed.
  for (const id of new Set(ids)) {
    expect(ids.filter((candidate) => candidate === id).length).toBe(2);
  }
});

it('undo forgets all journal items when rewinding to an empty conversation', () => {
  const store = new ConversationStore();
  const tracker = new SessionToolTracker(store);
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => tracker.getCurrentTurnId() });
  const lifecycle = makeLifecycle({ store, tracker, journal });

  store.addUserMessage('first');
  tracker.beginTurn();
  recordToolPair(journal, tracker, 'call_a', 'a');

  store.removeLastUserTurn();
  lifecycle.afterUndo();

  expect(journal.getEvents()).toEqual([]);
});
