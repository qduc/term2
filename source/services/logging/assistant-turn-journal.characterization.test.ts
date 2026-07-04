import { it, expect, describe } from 'vitest';
import { AssistantTurnJournal } from './assistant-turn-journal.js';
import { ToolExecutionLedger, type SavedToolExecution } from '../tool-execution-ledger.js';
import { buildToolLedgerFromAssistantTurnItems } from '../conversation/journal-to-ledger.js';
import type { LogEvent } from './conversation-log-events.js';

const makeSink = (): { events: LogEvent[]; sink: (e: LogEvent) => void } => {
  const events: LogEvent[] = [];
  return { events, sink: (e) => events.push(e) };
};

const runItemsFromEvents = (events: LogEvent[]) =>
  events
    .filter((e): e is Extract<LogEvent, { type: 'assistant_journal_item' }> => e.type === 'assistant_journal_item')
    .map((e) => e.item);

const ledgerFromJournal = (events: LogEvent[], turnId: string, startedAt: string) =>
  buildToolLedgerFromAssistantTurnItems(runItemsFromEvents(events), turnId, startedAt);

const withoutTimestamps = (entries: SavedToolExecution[]) =>
  entries.map((entry) => {
    const { startedAt: _s, completedAt: _c, ...rest } = entry;
    return rest;
  });

describe('AssistantTurnJournal output matches ToolExecutionLedger', () => {
  it('success turn with text, reasoning, and completed tool', () => {
    const { events, sink } = makeSink();
    const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });
    const ledger = new ToolExecutionLedger();
    ledger.beginTurn();

    journal.recordTextDelta('Hello');
    journal.recordReasoningDelta('I should use a tool.');
    journal.recordRunItem({
      rawItem: {
        type: 'function_call',
        callId: 'call-1',
        name: 'read_file',
        arguments: JSON.stringify({ file_path: 'a.ts' }),
      },
    });
    journal.recordRunItem({
      rawItem: {
        type: 'function_call_result',
        callId: 'call-1',
        name: 'read_file',
        output: 'contents',
      },
    });

    ledger.recordFunctionCall({
      rawItem: {
        type: 'function_call',
        callId: 'call-1',
        name: 'read_file',
        arguments: JSON.stringify({ file_path: 'a.ts' }),
      },
    });
    ledger.recordFunctionResult({
      rawItem: {
        type: 'function_call_result',
        callId: 'call-1',
        name: 'read_file',
        output: 'contents',
      },
    });

    const fromJournal = ledgerFromJournal(events, 'turn-1', '2026-07-04T00:00:00.000Z');
    const fromLedger = ledger.export();

    expect(withoutTimestamps(fromJournal)).toEqual(withoutTimestamps(fromLedger));
  });

  it('error turn with an incomplete tool call', () => {
    const { events, sink } = makeSink();
    const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });
    const ledger = new ToolExecutionLedger();
    ledger.beginTurn();

    journal.recordRunItem({
      rawItem: {
        type: 'function_call',
        callId: 'call-1',
        name: 'shell',
        arguments: JSON.stringify({ command: 'ls' }),
      },
    });

    ledger.recordFunctionCall({
      rawItem: {
        type: 'function_call',
        callId: 'call-1',
        name: 'shell',
        arguments: JSON.stringify({ command: 'ls' }),
      },
    });

    const fromJournal = ledgerFromJournal(events, 'turn-1', '2026-07-04T00:00:00.000Z');
    // Capture the ledger state before the abort is applied.
    const fromLedger = ledger.export();

    ledger.markOpenCallsAborted('stream failed');

    // The journal captures the provider-backed tool_call; the abort metadata
    // is recorded separately via tool_result log events.
    expect(withoutTimestamps(fromJournal)).toEqual(withoutTimestamps(fromLedger));
  });

  it('tool approval turn with a pending tool call', () => {
    const { events, sink } = makeSink();
    const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });
    const ledger = new ToolExecutionLedger();
    ledger.beginTurn();

    journal.recordRunItem({
      rawItem: {
        type: 'function_call',
        callId: 'call-1',
        name: 'shell',
        arguments: JSON.stringify({ command: 'rm file' }),
      },
    });

    ledger.recordFunctionCall({
      rawItem: {
        type: 'function_call',
        callId: 'call-1',
        name: 'shell',
        arguments: JSON.stringify({ command: 'rm file' }),
      },
    });

    const fromJournal = ledgerFromJournal(events, 'turn-1', '2026-07-04T00:00:00.000Z');
    const fromLedger = ledger.export();

    expect(withoutTimestamps(fromJournal)).toEqual(withoutTimestamps(fromLedger));
  });

  it('aborted turn records the rejection output', () => {
    const { events, sink } = makeSink();
    const journal = new AssistantTurnJournal({ getCurrentTurnId: () => 'turn-1', sink });
    const ledger = new ToolExecutionLedger();
    ledger.beginTurn();

    journal.recordRunItem({
      rawItem: {
        type: 'function_call',
        callId: 'call-1',
        name: 'shell',
        arguments: JSON.stringify({ command: 'rm file' }),
      },
    });

    ledger.recordFunctionCall({
      rawItem: {
        type: 'function_call',
        callId: 'call-1',
        name: 'shell',
        arguments: JSON.stringify({ command: 'rm file' }),
      },
    });

    const fromJournal = ledgerFromJournal(events, 'turn-1', '2026-07-04T00:00:00.000Z');
    // Capture the ledger state before the rejection is applied.
    const fromLedger = ledger.export();

    ledger.recordAbortedApproval('rejected', 'Tool execution was not approved.', 'call-1');

    // The journal captures the provider-backed tool_call; the abort result is
    // recorded separately via tool_result log events.
    expect(withoutTimestamps(fromJournal)).toEqual(withoutTimestamps(fromLedger));
  });
});
