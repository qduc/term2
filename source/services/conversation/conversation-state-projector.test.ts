import { expect, it } from 'vitest';
import type { ProviderInputItem as AgentInputItem } from '../../contracts/provider-input.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import {
  projectImportedState,
  projectModelRequestHistory,
  projectProviderHistory,
  projectSnapshot,
  ProjectionWarningCode,
} from './conversation-state-projector.js';

const completedLedgerEntry = (): SavedToolExecution => ({
  turnId: 'turn-1',
  callId: 'call-read',
  toolName: 'read_file',
  arguments: '{}',
  status: 'completed',
  startedAt: '2026-05-26T00:00:00.000Z',
  completedAt: '2026-05-26T00:00:01.000Z',
  historyItems: [
    { type: 'function_call', id: 'fc_1', callId: 'call-read', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', id: 'fcr_1', callId: 'call-read', output: 'contents' },
  ],
});

const abortedLedgerEntry = (): SavedToolExecution => ({
  turnId: 'turn-1',
  callId: 'call-write',
  toolName: 'apply_patch',
  arguments: '{}',
  status: 'aborted',
  startedAt: '2026-05-26T00:00:02.000Z',
  failureReason: 'stream failed',
});

it('projectProviderHistory inserts completed ledger pairs once', () => {
  const history: AgentInputItem[] = [{ role: 'user', type: 'message', content: 'continue' }];

  const first = projectProviderHistory({ history, toolLedger: [completedLedgerEntry()] });
  expect(first.history.map((item: any) => item.callId).filter(Boolean)).toEqual(['call-read', 'call-read']);
  expect(first.warnings).toEqual([
    {
      code: ProjectionWarningCode.CompletedToolHistoryInserted,
      detail: { addedCompletedPairs: 1 },
    },
  ]);

  const second = projectProviderHistory({ history: first.history, toolLedger: [completedLedgerEntry()] });
  expect(second.history).toEqual(first.history);
  expect(second.warnings).toEqual([]);
});

it('projectProviderHistory replaces a lone compact tool result with the ledger pair instead of duplicating it', () => {
  // A compact assistant_turn persists only a turn's last tool result, so
  // replayed history can contain a lone function_call_result with no
  // preceding function_call. Re-inserting the ledger pair must replace that
  // fragment, not duplicate it — a duplicated result whose copy precedes its
  // call is rejected by OpenAI-compatible providers with HTTP 400
  // ("Messages with role 'tool' must be a response to a preceding message
  // with 'tool_calls'").
  const history: AgentInputItem[] = [
    { role: 'user', type: 'message', content: 'run the tool' },
    {
      type: 'function_call_result',
      id: 'fcr_1',
      callId: 'call-read',
      name: 'read_file',
      output: 'contents',
    } as AgentInputItem,
    { role: 'assistant', type: 'message', content: 'done' },
  ];

  const projected = projectProviderHistory({ history, toolLedger: [completedLedgerEntry()] });

  const toolItems = projected.history.filter(
    (item: any) => item.type === 'function_call' || item.type === 'function_call_result',
  );
  expect(toolItems.map((item: any) => item.callId)).toEqual(['call-read', 'call-read']);
  expect(toolItems.map((item: any) => item.type)).toEqual(['function_call', 'function_call_result']);
  expect(projected.warnings).toEqual([
    {
      code: ProjectionWarningCode.CompletedToolHistoryInserted,
      detail: { addedCompletedPairs: 1 },
    },
  ]);
});

it('projectProviderHistory does not reinsert tool pairs behind a compaction marker', () => {
  const history: AgentInputItem[] = [
    { role: 'user', type: 'message', content: 'run the tool' },
    {
      type: 'compaction',
      id: 'cmp-1',
      encrypted_content: 'cipher',
      providerOpaque: { provider: 'openai' },
    } as AgentInputItem,
    { role: 'assistant', type: 'message', content: 'Compacted.' },
  ];

  const projected = projectProviderHistory({ history, toolLedger: [completedLedgerEntry()] });

  expect(projected.history).toEqual(history);
  expect(projected.warnings).toEqual([]);
});

it('keeps genuine turns in additive projections but omits them from model requests after a local checkpoint', () => {
  const checkpoint = {
    role: 'system',
    type: 'message',
    content: 'summary',
    contextSummary: {
      version: 1,
      strategy: 'local',
      replacesThroughRevision: 4,
      sourceProvider: 'openrouter',
      sourceModel: 'model',
      estimatedTokensBefore: 10_000,
      estimatedTokensAfter: 2_000,
      rearmAtEstimatedTokens: 10_000,
    },
  } as const;
  const hotTurn = { role: 'user', type: 'message', content: 'latest' } as const;
  const history: AgentInputItem[] = [
    { role: 'user', type: 'message', content: 'old genuine turn' },
    checkpoint,
    hotTurn,
  ];

  expect(projectProviderHistory({ history, toolLedger: [completedLedgerEntry()] }).history).toEqual(history);
  expect(projectSnapshot({ history, previousResponseId: null }).history).toEqual(history);
  expect(projectImportedState({ history, previousResponseId: null }).history).toEqual(history);
  expect(projectModelRequestHistory(history)).toEqual([checkpoint, hotTurn]);
  expect(projectModelRequestHistory(projectModelRequestHistory(history))).toEqual([checkpoint, hotTurn]);
});

it('projects from the latest replacement checkpoint', () => {
  const native = {
    type: 'compaction',
    encrypted_content: 'cipher',
    providerOpaque: { provider: 'openai' },
  } as AgentInputItem;
  const local = {
    role: 'system',
    type: 'message',
    content: 'new summary',
    contextSummary: { version: 1, strategy: 'local' },
  } as AgentInputItem;
  const tail = { role: 'user', type: 'message', content: 'tail' } as AgentInputItem;

  expect(projectModelRequestHistory([{ role: 'user', content: 'old' }, native, local, tail])).toEqual([local, tail]);
});

it('projectProviderHistory reports incomplete ledger entries without injecting completed history', () => {
  const history: AgentInputItem[] = [{ role: 'user', type: 'message', content: 'continue' }];

  const projected = projectProviderHistory({ history, toolLedger: [abortedLedgerEntry()] });

  expect(projected.history).toEqual(history);
  expect(projected.warnings).toEqual([
    {
      code: ProjectionWarningCode.IncompleteToolHistoryDropped,
      detail: { droppedIncompleteCalls: 1 },
    },
  ]);
});

it('projectProviderHistory injects unknown ledger pairs with verify-before-retry output', () => {
  const history: AgentInputItem[] = [{ role: 'user', type: 'message', content: 'continue' }];
  const unknownEntry: SavedToolExecution = {
    turnId: 'turn-1',
    callId: 'call-shell',
    toolName: 'shell',
    arguments: '{}',
    status: 'unknown',
    startedAt: '2026-05-26T00:00:00.000Z',
    dispatchedAt: '2026-05-26T00:00:00.500Z',
    completedAt: '2026-05-26T00:00:01.000Z',
    output: 'Outcome unobserved: verify before any retry',
    historyItems: [
      { type: 'function_call', callId: 'call-shell', name: 'shell', arguments: '{}' },
      {
        type: 'function_call_output',
        callId: 'call-shell',
        output: 'Outcome unobserved: verify before any retry',
      },
    ],
  };

  const projected = projectProviderHistory({ history, toolLedger: [unknownEntry] });

  expect(projected.history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', callId: 'call-shell' }),
      expect.objectContaining({
        type: 'function_call_output',
        callId: 'call-shell',
        output: expect.stringContaining('Outcome unobserved'),
      }),
    ]),
  );
  expect(projected.warnings).toEqual([
    {
      code: ProjectionWarningCode.CompletedToolHistoryInserted,
      detail: { addedCompletedPairs: 1 },
    },
  ]);
});

it('projectProviderHistory is pure and idempotent', () => {
  const history: AgentInputItem[] = [{ role: 'user', type: 'message', content: 'continue' }];
  const ledger = [completedLedgerEntry(), abortedLedgerEntry()];
  const originalHistory = structuredClone(history);
  const originalLedger = structuredClone(ledger);

  const first = projectProviderHistory({ history, toolLedger: ledger });
  const second = projectProviderHistory({ history: first.history, toolLedger: ledger });

  expect(history).toEqual(originalHistory);
  expect(ledger).toEqual(originalLedger);
  expect(second.history).toEqual(first.history);
  expect(second.warnings).toEqual([
    {
      code: ProjectionWarningCode.IncompleteToolHistoryDropped,
      detail: { droppedIncompleteCalls: 1 },
    },
  ]);
});

it('projectSnapshot returns the reconciled provider history and cloned ledger', () => {
  const history: AgentInputItem[] = [{ role: 'user', type: 'message', content: 'continue' }];
  const ledger = [completedLedgerEntry()];

  const snapshot = projectSnapshot({
    history,
    toolLedger: ledger,
    previousResponseId: 'resp-1',
    model: 'gpt-5',
    provider: 'openai',
  });

  expect(snapshot.history).toHaveLength(3);
  expect(snapshot.previousResponseId).toBe('resp-1');
  expect(snapshot.model).toBe('gpt-5');
  expect(snapshot.provider).toBe('openai');
  expect(snapshot.toolLedger).toEqual(ledger);
  expect(snapshot.toolLedger).not.toBe(ledger);
});

it('projectImportedState validates typed inputs by projecting history and ledger together', () => {
  const history: AgentInputItem[] = [{ role: 'user', type: 'message', content: 'continue' }];

  const projected = projectImportedState({
    history,
    previousResponseId: null,
    toolLedger: [completedLedgerEntry(), abortedLedgerEntry()],
  });

  expect(projected.history).toHaveLength(3);
  expect(projected.toolLedger).toHaveLength(2);
  expect(projected.previousResponseId).toBe(null);
  expect(projected.warnings.map((warning) => warning.code)).toEqual([
    ProjectionWarningCode.CompletedToolHistoryInserted,
    ProjectionWarningCode.IncompleteToolHistoryDropped,
  ]);
});
