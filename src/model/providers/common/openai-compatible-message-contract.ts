export function hasOpenAICompatibleAssistantPayload(message: any): boolean {
  if (message?.role !== 'assistant') return true;

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;

  if (typeof message.content === 'string') return message.content.length > 0;
  if (Array.isArray(message.content)) return message.content.length > 0;

  return false;
}

/**
 * Enforces the minimum Chat Completions wire contract shared by compatible
 * providers. Reasoning fields are metadata and cannot form an assistant turn
 * without visible content or a tool call.
 */
export function assertValidOpenAICompatibleMessages(messages: readonly any[]): void {
  const invalidIndex = messages.findIndex((message) => !hasOpenAICompatibleAssistantPayload(message));
  if (invalidIndex < 0) return;

  throw new Error(
    `Invalid OpenAI-compatible assistant message at index ${invalidIndex}: content or tool_calls must be set`,
  );
}
