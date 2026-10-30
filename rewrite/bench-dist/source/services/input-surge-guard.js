import { toolOccurrenceKey } from './conversation/tool-occurrence.js';
import { normalizeRunItem } from './conversation/run-item-normalizer.js';
const DEFAULT_INPUT_SURGE_GUARD_CONFIG = {
    maxDuplicateToolCallSignatureCount: 4,
    minDuplicateToolCallSignaturesForBlock: 20,
};
const normalizedToolItems = (item) => normalizeRunItem(item).filter((candidate) => candidate.type === 'tool_call' || candidate.type === 'tool_result');
const toolCallSignature = (item) => {
    const normalized = normalizedToolItems(item).find((candidate) => candidate.callId !== 'unknown-call');
    return normalized ? `${normalized.type}:${toolOccurrenceKey(normalized)}` : null;
};
const serializedBytes = (input) => {
    try {
        const serialized = JSON.stringify(input);
        return Buffer.byteLength(serialized ?? String(input));
    }
    catch {
        return Buffer.byteLength(String(input));
    }
};
export const collectInputSurgeStats = (input) => {
    const items = Array.isArray(input) ? input : [input];
    const toolCallCounts = new Map();
    for (const item of items) {
        const signature = toolCallSignature(item);
        if (!signature) {
            continue;
        }
        toolCallCounts.set(signature, (toolCallCounts.get(signature) ?? 0) + 1);
    }
    const duplicateCounts = [...toolCallCounts.values()].filter((count) => count > 1);
    return {
        messageCount: items.length,
        totalSerializedBytes: serializedBytes(input),
        duplicateToolCallSignatures: duplicateCounts.length,
        maxDuplicateToolCallSignatureCount: duplicateCounts.length > 0 ? Math.max(...duplicateCounts) : 0,
    };
};
export const collectDuplicateToolCallResultPairs = (input) => {
    const items = Array.isArray(input) ? input : [input];
    const calls = new Map();
    const results = new Map();
    for (const item of items) {
        for (const normalized of normalizedToolItems(item)) {
            if (normalized.callId === 'unknown-call')
                continue;
            if (normalized.type === 'tool_call') {
                calls.set(toolOccurrenceKey(normalized), (calls.get(toolOccurrenceKey(normalized)) ?? 0) + 1);
            }
            if (normalized.type === 'tool_result') {
                results.set(toolOccurrenceKey(normalized), (results.get(toolOccurrenceKey(normalized)) ?? 0) + 1);
            }
        }
    }
    let pairs = 0;
    let maxCopies = 0;
    for (const [callId, callCount] of calls) {
        const copies = Math.min(callCount, results.get(callId) ?? 0);
        if (copies < 2) {
            continue;
        }
        pairs++;
        maxCopies = Math.max(maxCopies, copies);
    }
    return { pairs, maxCopies };
};
export class InputSurgeGuard {
    #config;
    constructor(config = {}) {
        this.#config = { ...DEFAULT_INPUT_SURGE_GUARD_CONFIG, ...config };
    }
    reset() { }
    inspect(input, _options = {}) {
        const stats = collectInputSurgeStats(input);
        const duplicatePairs = collectDuplicateToolCallResultPairs(input);
        if (duplicatePairs.pairs >= 3 && duplicatePairs.maxCopies >= 2) {
            return {
                action: 'block',
                reason: `Detected replayed tool call/result pairs: ${duplicatePairs.pairs} duplicated pairs, max repetition ${duplicatePairs.maxCopies}.`,
                stats,
            };
        }
        if (stats.maxDuplicateToolCallSignatureCount >= this.#config.maxDuplicateToolCallSignatureCount &&
            stats.duplicateToolCallSignatures >= this.#config.minDuplicateToolCallSignaturesForBlock) {
            return {
                action: 'block',
                reason: `Detected replayed tool-call history: ${stats.duplicateToolCallSignatures} duplicated tool-call signatures, max repetition ${stats.maxDuplicateToolCallSignatureCount}.`,
                stats,
            };
        }
        return { action: 'allow', stats };
    }
    recordSuccessfulInput(_input, _options = {}) { }
}
//# sourceMappingURL=input-surge-guard.js.map