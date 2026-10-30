export function parseToolCallArguments(args, { callId, toolName, sessionId, traceId, }) {
    if (typeof args !== 'string') {
        return { arguments: args };
    }
    const trimmed = args.trim();
    if (!trimmed) {
        return { arguments: args };
    }
    try {
        return { arguments: JSON.parse(trimmed) };
    }
    catch {
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
//# sourceMappingURL=tool-call-arguments.js.map