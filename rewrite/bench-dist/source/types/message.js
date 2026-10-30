export const isUserMessage = (message) => message.sender === 'user';
export const isBotMessage = (message) => message.sender === 'bot';
export const isCommandMessage = (message) => message.sender === 'command';
export const isSubagentActivityMessage = (message) => message.sender === 'subagent';
export const isResultToolEvent = (tool) => {
    if (tool && typeof tool === 'object') {
        return tool.status === 'completed' || tool.status === 'failed' || tool.success !== undefined;
    }
    if (typeof tool === 'string') {
        return (tool.endsWith(' (Success)') ||
            tool.endsWith(' (Failed)') ||
            tool.endsWith(' (Cancelled)') ||
            /\s+\(Failed:.*\)$/.test(tool) ||
            /\s+\(\d+\s+match(es)?\)$/.test(tool));
    }
    return false;
};
//# sourceMappingURL=message.js.map