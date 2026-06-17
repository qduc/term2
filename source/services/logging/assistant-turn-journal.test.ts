import { it, expect } from 'vitest';
import { AssistantTurnJournal } from './assistant-turn-journal.js';
import type { LogEvent } from './conversation-log-events.js';

const makeSink = (): { events: LogEvent[]; sink: (e: LogEvent) => void } => {
  const events: LogEvent[] = [];
  return { events, sink: (e) => events.push(e) };
};

it('AssistantTurnJournal: emits monotonic per-turn journal sequence numbers', () => {
  const { events, sink } = makeSink();
  const journal = new AssistantTurnJournal({
    getCurrentTurnId: () => 'turn-3',
    sink,
  });
  journal.recordReasoningDelta('a');
  journal.recordTextDelta('b');
  journal.recordTextDelta('c');
  expect(events).toEqual([
    { type: 'assistant_journal_delta', turnId: 'turn-3', seq: 1, kind: 'reasoning', delta: 'a' },
    { type: 'assistant_journal_delta', turnId: 'turn-3', seq: 2, kind: 'text', delta: 'b' },
    { type: 'assistant_journal_delta', turnId: 'turn-3', seq: 3, kind: 'text', delta: 'c' },
  ]);
});

it('AssistantTurnJournal: empty deltas are not recorded', () => {
  const { events, sink } = makeSink();
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });
  journal.recordTextDelta('');
  journal.recordReasoningDelta('');
  expect(events).toEqual([]);
  expect(journal.peekNextSeq()).toBe(1);
});

it('AssistantTurnJournal: resetForNewTurn zeros the per-turn sequence', () => {
  const { events, sink } = makeSink();
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });
  journal.recordTextDelta('hi');
  journal.recordTextDelta(' there');
  journal.resetForNewTurn();
  journal.recordTextDelta('new');
  expect(events.map((e) => (e.type === 'assistant_journal_delta' ? e.seq : null))).toEqual([1, 2, 1]);
});

it('AssistantTurnJournal: normalizes function_call raw items into persisted tool_call items', () => {
  const { events, sink } = makeSink();
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });
  const persisted = journal.recordRunItem({
    rawItem: {
      type: 'function_call',
      callId: 'call-1',
      name: 'shell',
      arguments: JSON.stringify({ command: 'ls' }),
    },
  });
  expect(persisted.length > 0).toBe(true);
  expect(persisted[0]?.type).toBe('tool_call');
  expect(events).toEqual([
    {
      type: 'assistant_journal_item',
      turnId: 'turn-1',
      seq: 1,
      item: {
        type: 'tool_call',
        callId: 'call-1',
        toolName: 'shell',
        arguments: JSON.stringify({ command: 'ls' }),
        providerItem: {
          type: 'function_call',
          callId: 'call-1',
          name: 'shell',
          arguments: JSON.stringify({ command: 'ls' }),
        },
      },
    },
  ]);
});

it('AssistantTurnJournal: normalizes tool result raw items into persisted tool_result items', () => {
  const { events, sink } = makeSink();
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });
  const persisted = journal.recordRunItem({
    rawItem: {
      type: 'function_call_result',
      callId: 'call-1',
      name: 'shell',
      output: 'file.txt',
    },
  });
  expect(persisted[0]?.type).toBe('tool_result');
  expect(persisted[0] && persisted[0].type === 'tool_result' ? persisted[0].output : undefined).toBe('file.txt');
  expect(events.length).toBe(1);
  expect(events[0].type).toBe('assistant_journal_item');
});

it('AssistantTurnJournal: preserves the same turn id across approval continuation', () => {
  const { events, sink } = makeSink();
  let currentTurn = 'turn-2';
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => currentTurn, sink });

  journal.recordTextDelta('pre-approval');
  // Simulate an approval pause: same turn id, same journal instance.
  currentTurn = 'turn-2';
  journal.recordTextDelta(' post-approval');
  // And another segment: same turn id, no reset.
  currentTurn = 'turn-2';
  journal.recordRunItem({
    rawItem: { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' },
  });

  // Once the user submits the NEXT turn, the journal must be reset.
  journal.resetForNewTurn();
  currentTurn = 'turn-3';
  journal.recordTextDelta('new turn');

  const turnIds = events.map((e) => (e as { turnId: string }).turnId);
  expect(turnIds).toEqual(['turn-2', 'turn-2', 'turn-2', 'turn-3']);
});

it('AssistantTurnJournal: dedupes duplicate raw items within the same turn', () => {
  const { events, sink } = makeSink();
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });
  const item = { rawItem: { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' } };
  const first = journal.recordRunItem(item);
  const second = journal.recordRunItem(item);
  expect(first.length > 0).toBe(true);
  expect(second).toEqual([]);
  expect(events.filter((e) => e.type === 'assistant_journal_item').length).toBe(1);
});
