import type { FormatCommandMessage, ToolDefinition } from './types.js';

const toolFormatters = new Map<string, FormatCommandMessage>();

export const registerToolFormatters = (
  tools: Iterable<Pick<ToolDefinition, 'name' | 'formatCommandMessage'>>,
): void => {
  for (const tool of tools) {
    toolFormatters.set(tool.name, tool.formatCommandMessage);
  }
};

export const getToolFormatter = (toolName: string): FormatCommandMessage | undefined => {
  return toolFormatters.get(toolName);
};

export const clearToolFormatters = (): void => {
  toolFormatters.clear();
};
