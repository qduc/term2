import test from 'ava';
import { AssistantTurnJournal } from './assistant-turn-journal.js';
import type { LogEvent } from './conversation-log-events.js';

const makeSink = (): { events: LogEvent[]; sink: (e: LogEvent) => void } => {
  const events: LogEvent[] = [];
  return { events, sink: (e) => events.push(e) };
};

test('AssistantTurnJournal: emits monotonic per-turn journal sequence numbers', (t) => {
  const { events, sink } = makeSink();
  const journal = new AssistantTurnJournal({
    getCurrentTurnId: () => 'turn-3',
    sink,
  });
  journal.recordReasoningDelta('a');
  journal.recordTextDelta('b');
  journal.recordTextDelta('c');
  t.deepEqual(events, [
    { type: 'assistant_journal_delta', turnId: 'turn-3', seq: 1, kind: 'reasoning', delta: 'a' },
    { type: 'assistant_journal_delta', turnId: 'turn-3', seq: 2, kind: 'text', delta: 'b' },
    { type: 'assistant_journal_delta', turnId: 'turn-3', seq: 3, kind: 'text', delta: 'c' },
  ]);
});

test('AssistantTurnJournal: empty deltas are not recorded', (t) => {
  const { events, sink } = makeSink();
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });
  journal.recordTextDelta('');
  journal.recordReasoningDelta('');
  t.deepEqual(events, []);
  t.is(journal.peekNextSeq(), 1);
});

test('AssistantTurnJournal: resetForNewTurn zeros the per-turn sequence', (t) => {
  const { events, sink } = makeSink();
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });
  journal.recordTextDelta('hi');
  journal.recordTextDelta(' there');
  journal.resetForNewTurn();
  journal.recordTextDelta('new');
  t.deepEqual(
    events.map((e) => (e.type === 'assistant_journal_delta' ? e.seq : null)),
    [1, 2, 1],
  );
});

test('AssistantTurnJournal: normalizes function_call raw items into persisted tool_call items', (t) => {
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
  t.true(persisted.length > 0);
  t.is(persisted[0]?.type, 'tool_call');
  t.deepEqual(events, [
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

test('AssistantTurnJournal: normalizes tool result raw items into persisted tool_result items', (t) => {
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
  t.is(persisted[0]?.type, 'tool_result');
  t.is(persisted[0] && persisted[0].type === 'tool_result' ? persisted[0].output : undefined, 'file.txt');
  t.is(events.length, 1);
  t.is(events[0].type, 'assistant_journal_item');
});

test('AssistantTurnJournal: preserves the same turn id across approval continuation', (t) => {
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
  t.deepEqual(turnIds, ['turn-2', 'turn-2', 'turn-2', 'turn-3']);
});

test('AssistantTurnJournal: dedupes duplicate raw items within the same turn', (t) => {
  const { events, sink } = makeSink();
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });
  const item = { rawItem: { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' } };
  const first = journal.recordRunItem(item);
  const second = journal.recordRunItem(item);
  t.true(first.length > 0);
  t.deepEqual(second, []);
  t.is(events.filter((e) => e.type === 'assistant_journal_item').length, 1);
});
