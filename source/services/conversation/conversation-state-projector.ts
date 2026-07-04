import type { AgentInputItem } from '@openai/agents';
import type { StateSnapshot } from '../logging/conversation-log-events.js';
import { reconcileHistoryWithToolLedger, type SavedToolExecution } from '../tool-execution-ledger.js';

export enum ProjectionWarningCode {
  CompletedToolHistoryInserted = 'completed_tool_history_inserted',
  IncompleteToolHistoryDropped = 'incomplete_tool_history_dropped',
}

export type ProjectionWarning = {
  code: ProjectionWarningCode;
  detail?: unknown;
};

export type ProviderHistoryProjection = {
  history: AgentInputItem[];
  warnings: ProjectionWarning[];
};

export type ImportedStateProjection = {
  history: AgentInputItem[];
  previousResponseId: string | null;
  toolLedger: SavedToolExecution[];
  warnings: ProjectionWarning[];
};

const clone = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
};

const warningsFromReconciliation = (result: {
  addedCompletedPairs: number;
  droppedIncompleteCalls: number;
}): ProjectionWarning[] => {
  const warnings: ProjectionWarning[] = [];
  if (result.addedCompletedPairs > 0) {
    warnings.push({
      code: ProjectionWarningCode.CompletedToolHistoryInserted,
      detail: { addedCompletedPairs: result.addedCompletedPairs },
    });
  }
  if (result.droppedIncompleteCalls > 0) {
    warnings.push({
      code: ProjectionWarningCode.IncompleteToolHistoryDropped,
      detail: { droppedIncompleteCalls: result.droppedIncompleteCalls },
    });
  }
  return warnings;
};

/**
 * Projects the live provider-facing transcript from the current transcript
 * store plus the tool ledger. This is the only module that should decide how
 * recoverable tool call/result pairs are merged back into provider history.
 *
 * Precedence summary:
 * - completed ledger call/result pairs missing from history are inserted once;
 * - completed pairs already present in history are not duplicated;
 * - incomplete ledger entries are reported but never injected as completed
 *   provider history.
 *
 * Projection functions must stay stateless, must not mutate their inputs, and
 * must be idempotent for equivalent inputs.
 */
export function projectProviderHistory(input: {
  history: readonly unknown[];
  toolLedger?: readonly SavedToolExecution[];
}): ProviderHistoryProjection {
  const reconciled = reconcileHistoryWithToolLedger(input.history, input.toolLedger);
  return {
    history: reconciled.history as AgentInputItem[],
    warnings: warningsFromReconciliation(reconciled),
  };
}

export function projectSnapshot(input: {
  history: readonly unknown[];
  toolLedger?: readonly SavedToolExecution[];
  previousResponseId: string | null;
  model?: string;
  provider?: string;
}): StateSnapshot {
  const projected = projectProviderHistory(input);
  return {
    history: projected.history,
    previousResponseId: input.previousResponseId,
    toolLedger: clone([...(input.toolLedger ?? [])]),
    ...(input.model ? { model: input.model } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
  };
}

export function projectImportedState(input: {
  history: readonly unknown[];
  previousResponseId: string | null;
  toolLedger?: readonly SavedToolExecution[];
}): ImportedStateProjection {
  const projected = projectProviderHistory(input);
  return {
    history: projected.history,
    previousResponseId: input.previousResponseId,
    toolLedger: clone([...(input.toolLedger ?? [])]),
    warnings: projected.warnings,
  };
}
