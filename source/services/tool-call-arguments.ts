export const normalizeToolCallArguments = (args: unknown): unknown => {
  if (typeof args !== 'string') {
    return args;
  }

  const trimmed = args.trim();
  if (!trimmed) {
    return args;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return args;
  }
};

export interface ToolCallArgumentParseResult {
  arguments: unknown;
  invalidJsonDiagnostic?: {
    toolName: string;
    toolCallId: string;
    rawPayload: string;
    normalizedToolCall: Record<string, unknown>;
    validationErrors: string[];
    traceId: string;
    retryContext: Record<string, unknown>;
  };
}

export function parseToolCallArguments(
  args: unknown,
  {
    callId,
    toolName,
    sessionId,
    traceId,
  }: {
    callId: string;
    toolName: string;
    sessionId: string;
    traceId: string;
  },
): ToolCallArgumentParseResult {
  if (typeof args !== 'string') {
    return { arguments: args };
  }

  const trimmed = args.trim();
  if (!trimmed) {
    return { arguments: args };
  }

  try {
    return { arguments: JSON.parse(trimmed) };
  } catch {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return {
        arguments: args,
        invalidJsonDiagnostic: {
          toolName: toolName || 'unknown',
          toolCallId: callId,
          rawPayload: trimmed,
          normalizedToolCall: {
            toolName: toolName || 'unknown',
            toolCallId: callId,
            arguments: args,
          },
          validationErrors: ['arguments must be valid JSON'],
          traceId,
          retryContext: { sessionId },
        },
      };
    }
    return { arguments: args };
  }
}
