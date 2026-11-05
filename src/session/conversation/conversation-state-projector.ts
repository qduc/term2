import type { ProviderInputItem } from '../../shared/contracts/provider-input.js';
import { lastReplacementBoundaryIndex } from '../../model/history-projection.js';
export { isOpenAICompaction, projectModelRequestHistory } from '../../model/history-projection.js';
import type { StateSnapshot } from '../logging/conversation-log-events.js';
import {
  dropUnpairedFunctionCalls,
  reconcileHistoryWithToolLedger,
  type SavedToolExecution,
} from '../tool-execution-ledger.js';

export enum ProjectionWarningCode {
  CompletedToolHistoryInserted = 'completed_tool_history_inserted',
  IncompleteToolHistoryDropped = 'incomplete_tool_history_dropped',
  OrphanToolResultDropped = 'orphan_tool_result_dropped',
}

export type ProjectionWarning = {
  code: ProjectionWarningCode;
  detail?: unknown;
};

export type ProviderHistoryProjection = {
  history: ProviderInputItem[];
  warnings: ProjectionWarning[];
};

export type ImportedStateProjection = {
  history: ProviderInputItem[];
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
  coveredToolOccurrences?: ReadonlySet<string>;
}): ProviderHistoryProjection {
  // A provider compaction item is a complete replacement boundary. Replaying
  // completed tool pairs from the local ledger behind it would send stale
  // function calls back to the provider and can cause a side effect to run
  // again on the next stateless request.
  if (lastReplacementBoundaryIndex(input.history) >= 0) {
    return { history: clone([...input.history]) as ProviderInputItem[], warnings: [] };
  }
  const reconciled = reconcileHistoryWithToolLedger(input.history, input.toolLedger, input.coveredToolOccurrences);
  const paired = dropUnpairedFunctionCalls(reconciled.history);
  const removedCallIds = collectRemovedToolCallIds(reconciled.history, paired);
  const warnings = warningsFromReconciliation(reconciled);
  if (removedCallIds.length > 0) {
    warnings.push({
      code: ProjectionWarningCode.OrphanToolResultDropped,
      detail: { removedCallIds },
    });
  }
  return {
    history: paired as ProviderInputItem[],
    warnings,
  };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const toolCallIdOf = (item: unknown): string | undefined => {
  const record = asRecord(item);
  const raw = record ? asRecord(record.rawItem) ?? record : null;
  const callId = raw?.callId ?? raw?.call_id ?? raw?.tool_call_id ?? raw?.id;
  return typeof callId === 'string' && callId.length > 0 ? callId : undefined;
};

const collectRemovedToolCallIds = (original: readonly unknown[], filtered: readonly unknown[]): string[] => {
  const remaining = new Set(filtered.map(toolCallIdOf).filter((id): id is string => Boolean(id)));
  const removed: string[] = [];
  for (const item of original) {
    const callId = toolCallIdOf(item);
    if (callId && !remaining.has(callId) && !removed.includes(callId)) {
      removed.push(callId);
    }
  }
  return removed;
};

export function projectSnapshot(input: {
  history: readonly unknown[];
  toolLedger?: readonly SavedToolExecution[];
  coveredToolOccurrences?: ReadonlySet<string>;
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
  coveredToolOccurrences?: ReadonlySet<string>;
}): ImportedStateProjection {
  const projected = projectProviderHistory(input);
  return {
    history: projected.history,
    previousResponseId: input.previousResponseId,
    toolLedger: clone([...(input.toolLedger ?? [])]),
    warnings: projected.warnings,
  };
}
