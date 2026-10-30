import { getCallIdFromItem, normalizeToolArguments, getOutputText, } from '../../tools/format-helpers.js';
import { getToolFormatter } from '../../tools/command-message-formatters.js';
import { normalizeRunItem } from '../../services/conversation/run-item-normalizer.js';
/** Per-session/turn markers used to annotate tool results without process-global state. */
export class ToolCallMarkerStore {
    #approvalRejectionCallIds = new Set();
    #llmAutoApprovalCallIds = new Set();
    markToolCallAsLlmAutoApproved(callId) {
        if (callId)
            this.#llmAutoApprovalCallIds.add(callId);
    }
    clearLlmAutoApprovalMarkers() {
        this.#llmAutoApprovalCallIds.clear();
    }
    markToolCallAsApprovalRejection(callId) {
        if (callId)
            this.#approvalRejectionCallIds.add(callId);
    }
    clearApprovalRejectionMarkers() {
        this.#approvalRejectionCallIds.clear();
    }
    /** A new execution reused this call id: an earlier rejection must not mark its result. */
    forgetApprovalRejection(callId) {
        this.#approvalRejectionCallIds.delete(callId);
    }
    isApprovalRejectionForItem(item) {
        const callId = getCallIdFromItem(item);
        return callId ? this.#approvalRejectionCallIds.has(callId) : false;
    }
    consumeLlmAutoApprovalForItem(item) {
        const callId = getCallIdFromItem(item);
        if (!callId || !this.#llmAutoApprovalCallIds.has(callId))
            return false;
        this.#llmAutoApprovalCallIds.delete(callId);
        return true;
    }
}
const normalizeToolItem = (item) => {
    if (item.type !== 'tool_result') {
        return null;
    }
    return {
        toolName: item.toolName,
        arguments: undefined,
        outputText: getOutputText(item),
    };
};
const getProviderArguments = (item) => {
    const providerItem = item.providerItem;
    return providerItem?.arguments ?? providerItem?.args ?? providerItem?.operation;
};
export const extractCommandMessages = (items = [], markerStore = new ToolCallMarkerStore()) => {
    const messages = [];
    const toolCallArgumentsById = new Map();
    const normalizedItems = items.flatMap(normalizeRunItem);
    for (const item of normalizedItems) {
        if (item.type === 'tool_call' && item.arguments)
            toolCallArgumentsById.set(item.callId, item.arguments);
    }
    for (const [index, item] of normalizedItems.entries()) {
        const normalizedItem = normalizeToolItem(item);
        if (!normalizedItem) {
            continue;
        }
        const resultItem = item;
        const isApprovalRejection = markerStore.isApprovalRejectionForItem(resultItem);
        const autoApprovedByLlm = markerStore.consumeLlmAutoApprovalForItem(resultItem);
        const formatter = getToolFormatter(normalizedItem.toolName);
        if (formatter) {
            const argumentsForCall = toolCallArgumentsById.get(resultItem.callId) ?? getProviderArguments(resultItem);
            const enrichedItem = {
                ...resultItem,
                ...(argumentsForCall ? { arguments: argumentsForCall } : {}),
            };
            const results = formatter(enrichedItem, index, toolCallArgumentsById);
            results.forEach((msg) => {
                if (isApprovalRejection) {
                    msg.isApprovalRejection = true;
                }
                if (autoApprovedByLlm) {
                    msg.autoApprovedByLlm = true;
                }
            });
            messages.push(...results);
            continue;
        }
        // Generic fallback for any other tools
        const callId = getCallIdFromItem(resultItem);
        const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
        const args = normalizeToolArguments(resultItem.arguments) ??
            normalizeToolArguments(fallbackArgs) ??
            normalizeToolArguments(getProviderArguments(resultItem)) ??
            {};
        let command = normalizedItem.toolName;
        if (typeof args === 'string') {
            command += ` ${args}`;
        }
        else if (typeof args === 'object' && args !== null) {
            const parts = Object.values(args).map((v) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v)));
            if (parts.length > 0) {
                command += ` ${parts.join(' ')}`;
            }
        }
        const output = normalizedItem.outputText || 'No output';
        const success = !output.startsWith('Error:');
        const providerItem = resultItem.providerItem;
        const baseId = providerItem?.id ?? providerItem?.callId ?? resultItem.callId ?? `${Date.now()}-${index}`;
        const stableId = `${baseId}-0`;
        messages.push({
            id: stableId,
            sender: 'command',
            status: 'completed',
            command,
            output,
            success,
            isApprovalRejection,
            ...(autoApprovedByLlm ? { autoApprovedByLlm: true } : {}),
            toolName: normalizedItem.toolName,
            toolArgs: args,
            ...(callId ? { callId } : {}),
        });
    }
    return messages;
};
//# sourceMappingURL=extract-command-messages.js.map