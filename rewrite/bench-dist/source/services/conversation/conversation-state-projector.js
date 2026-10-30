import { isLocalContextSummary } from '../../contracts/provider-input.js';
import { dropUnpairedFunctionCalls, reconcileHistoryWithToolLedger, } from '../tool-execution-ledger.js';
export var ProjectionWarningCode;
(function (ProjectionWarningCode) {
    ProjectionWarningCode["CompletedToolHistoryInserted"] = "completed_tool_history_inserted";
    ProjectionWarningCode["IncompleteToolHistoryDropped"] = "incomplete_tool_history_dropped";
    ProjectionWarningCode["OrphanToolResultDropped"] = "orphan_tool_result_dropped";
})(ProjectionWarningCode || (ProjectionWarningCode = {}));
const clone = (value) => {
    try {
        return structuredClone(value);
    }
    catch {
        return JSON.parse(JSON.stringify(value));
    }
};
export const isOpenAICompaction = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
        return false;
    const record = item;
    if (record.type === 'provider_opaque' && record.provider === 'openai') {
        const payload = record.item;
        return payload?.type === 'compaction';
    }
    const marker = record.providerOpaque;
    return (record.type === 'compaction' &&
        !!marker &&
        typeof marker === 'object' &&
        !Array.isArray(marker) &&
        marker.provider === 'openai');
};
const isContextReplacementBoundary = (item) => isOpenAICompaction(item) || isLocalContextSummary(item);
const lastReplacementBoundaryIndex = (history) => {
    for (let index = history.length - 1; index >= 0; index--) {
        if (isContextReplacementBoundary(history[index]))
            return index;
    }
    return -1;
};
const warningsFromReconciliation = (result) => {
    const warnings = [];
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
export function projectProviderHistory(input) {
    // A provider compaction item is a complete replacement boundary. Replaying
    // completed tool pairs from the local ledger behind it would send stale
    // function calls back to the provider and can cause a side effect to run
    // again on the next stateless request.
    if (lastReplacementBoundaryIndex(input.history) >= 0) {
        return { history: clone([...input.history]), warnings: [] };
    }
    const reconciled = reconcileHistoryWithToolLedger(input.history, input.toolLedger);
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
        history: paired,
        warnings,
    };
}
const asRecord = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const toolCallIdOf = (item) => {
    const record = asRecord(item);
    const raw = record ? asRecord(record.rawItem) ?? record : null;
    const callId = raw?.callId ?? raw?.call_id ?? raw?.tool_call_id ?? raw?.id;
    return typeof callId === 'string' && callId.length > 0 ? callId : undefined;
};
const collectRemovedToolCallIds = (original, filtered) => {
    const remaining = new Set(filtered.map(toolCallIdOf).filter((id) => Boolean(id)));
    const removed = [];
    for (const item of original) {
        const callId = toolCallIdOf(item);
        if (callId && !remaining.has(callId) && !removed.includes(callId)) {
            removed.push(callId);
        }
    }
    return removed;
};
/**
 * Lossy projection used only when constructing a model request. Durable
 * snapshots/imports retain genuine pre-boundary user turns for navigation.
 */
export function projectModelRequestHistory(history) {
    const boundary = lastReplacementBoundaryIndex(history);
    return clone((boundary < 0 ? [...history] : history.slice(boundary)));
}
export function projectSnapshot(input) {
    const projected = projectProviderHistory(input);
    return {
        history: projected.history,
        previousResponseId: input.previousResponseId,
        toolLedger: clone([...(input.toolLedger ?? [])]),
        ...(input.model ? { model: input.model } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
    };
}
export function projectImportedState(input) {
    const projected = projectProviderHistory(input);
    return {
        history: projected.history,
        previousResponseId: input.previousResponseId,
        toolLedger: clone([...(input.toolLedger ?? [])]),
        warnings: projected.warnings,
    };
}
//# sourceMappingURL=conversation-state-projector.js.map