import { normalizeRunItem } from './conversation/run-item-normalizer.js';
import { extractCommandMessages } from '../utils/streaming/extract-command-messages.js';
const normalizedItems = (item) => normalizeRunItem(item);
export const captureToolCallArguments = (item, toolCallArgumentsById) => {
    for (const normalized of normalizedItems(item)) {
        if (normalized.type !== 'tool_call' || !normalized.arguments)
            continue;
        toolCallArgumentsById.set(normalized.callId, normalized.arguments);
    }
};
export const attachCachedArguments = (items = [], toolCallArgumentsById) => {
    return items.flatMap(normalizedItems).flatMap((item) => {
        if (item.type !== 'tool_result')
            return [];
        const argumentsForCall = toolCallArgumentsById.get(item.callId);
        return [{ ...item, ...(argumentsForCall ? { arguments: argumentsForCall } : {}) }];
    });
};
export const emitCommandMessagesFromItems = (items, { toolCallArgumentsById, emittedCommandIds, extractCommandMessages: extractCommandMessagesFn = extractCommandMessages, markerStore, }) => {
    const commandMessages = extractCommandMessagesFn(attachCachedArguments(items, toolCallArgumentsById), markerStore);
    const out = [];
    for (const cmdMsg of commandMessages) {
        if (emittedCommandIds.has(cmdMsg.id)) {
            continue;
        }
        emittedCommandIds.add(cmdMsg.id);
        out.push({ type: 'command_message', message: cmdMsg });
    }
    return out;
};
//# sourceMappingURL=command-message-streaming.js.map