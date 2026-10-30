const toolFormatters = new Map();
export const registerToolFormatters = (tools) => {
    for (const tool of tools) {
        toolFormatters.set(tool.name, tool.formatCommandMessage);
    }
};
export const getToolFormatter = (toolName) => {
    return toolFormatters.get(toolName);
};
export const clearToolFormatters = () => {
    toolFormatters.clear();
};
//# sourceMappingURL=command-message-formatters.js.map