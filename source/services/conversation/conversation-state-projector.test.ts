import { expect, it } from 'vitest';
import type { AgentInputItem } from '@openai/agents';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import {
  projectImportedState,
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
