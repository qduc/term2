import { describe, expect, it } from 'vitest';
import type { PersistedAssistantTurnItem } from './conversation-persistence-types.js';
import { buildToolLedgerFromAssistantTurnItems, buildToolLedgerFromJournalEvents } from './journal-to-ledger.js';

const turnId = 'turn-1';
const startedAt = '2026-07-28T00:00:00.000Z';

const itemRepresentations = [
  {
    name: 'wrapped provider items',
    toolCall: {
      rawItem: { type: 'function_call', callId: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    },
    toolResult: {
      rawItem: { type: 'function_call_result', callId: 'call-1', name: 'read_file', output: 'contents' },
    },
  },
  {
    name: 'direct provider items',
    toolCall: { type: 'function_call', callId: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    toolResult: { type: 'function_call_result', callId: 'call-1', name: 'read_file', output: 'contents' },
  },
  {
    name: 'canonical items',
    toolCall: { type: 'tool_call', callId: 'call-1', toolName: 'read_file', arguments: '{"path":"a.ts"}' },
    toolResult: {
      type: 'tool_result',
      callId: 'call-1',
      toolName: 'read_file',
      status: 'completed',
      output: 'contents',
    },
  },
] as const;

const turnItemsFor = (representation: (typeof itemRepresentations)[number]): PersistedAssistantTurnItem[] => [
  { type: 'reasoning', text: 'Inspect the file first.' },
  {
    type: 'tool_call',
    callId: 'call-1',
    toolName: 'read_file',
    arguments: '{"path":"a.ts"}',
    providerItem: representation.toolCall,
  },
  {
    type: 'tool_result',
    callId: 'call-1',
    toolName: 'read_file',
    status: 'completed',
    output: 'contents',
    providerItem: representation.toolResult,
  },
  {
    type: 'tool_result',
    callId: 'call-1',
    toolName: 'read_file',
    status: 'completed',
    output: 'contents',
    providerItem: representation.toolResult,
  },
];

describe('journal-to-ledger canonical history inspection', () => {
  it.each(itemRepresentations)('deduplicates an existing tool result in $name', (representation) => {
    const [entry] = buildToolLedgerFromAssistantTurnItems(turnItemsFor(representation), turnId, startedAt);

    expect(entry).toMatchObject({
      callId: 'call-1',
      toolName: 'read_file',
      status: 'completed',
      output: 'contents',
    });
    expect(entry.historyItems).toHaveLength(3);
    expect(entry.historyItems).toEqual([
      expect.objectContaining({ type: 'reasoning' }),
      representation.toolCall,
      representation.toolResult,
    ]);
  });

  it.each(itemRepresentations)(
    'uses the same missing-reasoning and result-deduplication behavior for $name journal events',
    (representation) => {
      const entries = buildToolLedgerFromJournalEvents(
        turnItemsFor(representation).map((item, index) => ({
          type: 'assistant_journal_item',
          turnId,
          seq: index + 1,
          item,
        })),
        startedAt,
      );

      expect(entries).toHaveLength(1);
      expect(entries[0]?.historyItems).toHaveLength(3);
      expect(entries[0]?.historyItems).toEqual([
        expect.objectContaining({ type: 'reasoning' }),
        representation.toolCall,
        representation.toolResult,
      ]);
    },
  );
});
