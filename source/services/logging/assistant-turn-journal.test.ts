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

it('AssistantTurnJournal: pruneToUserTurnCount drops items from removed turns', () => {
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1' });
  journal.recordRunItem({ rawItem: { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' } });
  journal.recordRunItem({
    rawItem: { type: 'function_call_result', callId: 'call-1', name: 'shell', output: 'out' },
  });

  const items = journal.getEvents().map((event) => (event.item as { callId?: string }).callId);
  expect(items).toEqual(['call-1', 'call-1']);

  journal.pruneToUserTurnCount(0);
  expect(journal.getEvents()).toEqual([]);
});

it('AssistantTurnJournal: pruneToUserTurnCount keeps surviving turns and non-turn ids', () => {
  let turnId = 'turn-1';
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => turnId });
  journal.recordRunItem({ rawItem: { type: 'function_call', callId: 'keep-me', name: 'shell', arguments: '{}' } });
  turnId = 'turn-2';
  journal.recordRunItem({ rawItem: { type: 'function_call', callId: 'drop-me', name: 'shell', arguments: '{}' } });
  turnId = 'custom-turn';
  journal.recordRunItem({
    rawItem: { type: 'function_call', callId: 'ambiguous-keep', name: 'shell', arguments: '{}' },
  });

  journal.pruneToUserTurnCount(1);

  const callIds = journal.getEvents().map((event) => (event.item as { callId?: string }).callId);
  expect(callIds).toEqual(['keep-me', 'ambiguous-keep']);
});

it('AssistantTurnJournal: clear empties buffered items and restarts sequence', () => {
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1' });
  journal.recordRunItem({ rawItem: { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' } });

  journal.clear();

  expect(journal.getEvents()).toEqual([]);
  expect(journal.peekNextSeq()).toBe(1);
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

it('AssistantTurnJournal: dedupes duplicate canonical tool calls within the same turn', () => {
  const { events, sink } = makeSink();
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });
  const item = { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: '{}' } as const;

  expect(journal.recordRunItem(item)).toEqual([item]);
  expect(journal.recordRunItem(item)).toEqual([]);
  expect(events.filter((event) => event.type === 'assistant_journal_item')).toHaveLength(1);
});

it('AssistantTurnJournal: treats wrapped and canonical tool calls as the same item', () => {
  const { events, sink } = makeSink();
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });

  expect(
    journal.recordRunItem({
      rawItem: { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' },
    }),
  ).toHaveLength(1);
  expect(journal.recordRunItem({ type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: '{}' })).toEqual(
    [],
  );
  expect(events.filter((event) => event.type === 'assistant_journal_item')).toHaveLength(1);
});

it('AssistantTurnJournal: suppresses an entire duplicate multi-item normalization', () => {
  const { events, sink } = makeSink();
  const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });
  const item = {
    rawItem: {
      type: 'message',
      id: 'message-1',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Done' }],
      providerData: { reasoning_content: 'Checked the result' },
    },
  };

  expect(journal.recordRunItem(item).map(({ type }) => type)).toEqual(['reasoning', 'assistant_text']);
  expect(journal.recordRunItem(item)).toEqual([]);
  expect(events.filter((event) => event.type === 'assistant_journal_item')).toHaveLength(2);
});
