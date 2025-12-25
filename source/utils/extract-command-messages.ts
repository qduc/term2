const SHELL_TOOL_NAME = 'shell';
const GREP_TOOL_NAME = 'grep';
const APPLY_PATCH_TOOL_NAME = 'apply_patch';
const SEARCH_REPLACE_TOOL_NAME = 'search_replace';
const ASK_MENTOR_TOOL_NAME = 'ask_mentor';

const approvalRejectionCallIds = new Set<string>();

const getCallIdFromItem = (item: any): string | null => {
    const rawItem = item?.rawItem ?? item;
    if (!rawItem) {
        return null;
    }

    return (
        rawItem.callId ??
        rawItem.call_id ??
        rawItem.tool_call_id ??
        rawItem.toolCallId ??
        rawItem.id ??
        item?.callId ??
        item?.call_id ??
        item?.tool_call_id ??
        item?.toolCallId ??
        item?.id ??
        null
    );
};

export const markToolCallAsApprovalRejection = (
    callId?: string | null,
): void => {
    if (!callId) {
        return;
    }
    approvalRejectionCallIds.add(callId);
};

export const clearApprovalRejectionMarkers = (): void => {
    approvalRejectionCallIds.clear();
};

const isApprovalRejectionForItem = (item: any): boolean => {
    const callId = getCallIdFromItem(item);
    if (!callId) {
        return false;
    }
    return approvalRejectionCallIds.has(callId);
};

interface CommandMessage {
    id: string;
    sender: 'command';
    command: string;
    output: string;
    success?: boolean;
    failureReason?: string;
    isApprovalRejection?: boolean;
    toolName?: string;
    toolArgs?: any;
    callId?: string;
}

const coerceToText = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        return value
            .map(part => coerceToText(part))
            .filter(Boolean)
            .join('\n');
    }

    if (typeof value === 'object') {
        if ('text' in value && typeof value.text === 'string') {
            return value.text;
        }

        if ('output' in value && typeof value.output === 'string') {
            return value.output;
        }

        try {
            return JSON.stringify(value);
        } catch {
            return '';
        }
    }

    return String(value);
};

const getOutputText = (item: any): string => {
    const sources = [item, item?.rawItem];

    for (const source of sources) {
        if (!source) {
            continue;
        }

        for (const candidate of [source.output, source.output?.text]) {
            const text = coerceToText(candidate);
            if (text) {
                return text;
            }
        }
    }

    return '';
};

const safeJsonParse = (payload: unknown): any => {
    if (typeof payload !== 'string') {
        return null;
    }

    const trimmed = payload.trim();
    if (!trimmed) {
        return null;
    }

    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
};

const normalizeToolArguments = (value: unknown): any => {
    if (!value) {
        return null;
    }

    if (typeof value === 'string') {
        return safeJsonParse(value) ?? value;
    }

    return value;
};

const coerceCommandText = (value: unknown): string => {
    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        return value
            .map(part => coerceToText(part))
            .filter(Boolean)
            .join('\n');
    }

    return coerceToText(value);
};

const normalizeToolItem = (
    item: any,
): {toolName: string; arguments: any; outputText: string} | null => {
    if (!item) {
        return null;
    }

    const rawItem = item.rawItem ?? item;
    const type = item.type ?? rawItem?.type;
    const isFunctionResult =
        type === 'function_call_result' ||
        rawItem?.type === 'function_call_result' ||
        type === 'function_call_output' ||
        rawItem?.type === 'function_call_output' ||
        type === 'function_call_output_result' ||
        rawItem?.type === 'function_call_output_result';
    const isToolCallOutput = type === 'tool_call_output_item';

    if (!isFunctionResult && !isToolCallOutput) {
        return null;
    }

    const toolName = rawItem?.name ?? item.name;
    if (!toolName) {
        return null;
    }

    return {
        toolName,
        arguments: rawItem?.arguments ?? item.arguments,
        outputText: getOutputText(item),
    };
};

export const extractCommandMessages = (items: any[] = []): CommandMessage[] => {
    const messages: CommandMessage[] = [];
    const toolCallArgumentsById = new Map<string, unknown>();

    for (const item of items ?? []) {
        const rawItem = item?.rawItem ?? item;
        if (!rawItem) {
            continue;
        }

        const type = rawItem?.type ?? item?.type;
        if (type !== 'function_call') {
            continue;
        }

        const callId = getCallIdFromItem(rawItem) ?? getCallIdFromItem(item);
        if (!callId) {
            continue;
        }

        const args =
            rawItem.arguments ?? rawItem.args ?? item?.arguments ?? item?.args;
        if (!args) {
            continue;
        }

        toolCallArgumentsById.set(callId, args);
    }

    for (const [index, item] of (items ?? []).entries()) {
        const normalizedItem = normalizeToolItem(item);
        if (!normalizedItem) {
            continue;
        }

        const isApprovalRejection = isApprovalRejectionForItem(item);
        const callId = getCallIdFromItem(item);

        // Handle shell tool
        if (normalizedItem.toolName === SHELL_TOOL_NAME) {
            const rawItem = item?.rawItem ?? item;
            const callId = getCallIdFromItem(item);
            const fallbackArgs =
                callId && toolCallArgumentsById.has(callId)
                    ? toolCallArgumentsById.get(callId)
                    : null;
            const args =
                normalizeToolArguments(normalizedItem.arguments) ??
                normalizeToolArguments(fallbackArgs) ??
                {};
            const command = (() => {
                if (typeof args === 'string') {
                    return args;
                }

                const directCommand = coerceCommandText((args as any)?.command);
                if (directCommand) {
                    return directCommand;
                }

                const commandsValue = (args as any)?.commands;
                if (typeof commandsValue === 'string') {
                    return commandsValue;
                }

                if (Array.isArray(commandsValue)) {
                    const commands = commandsValue
                        .map(entry =>
                            typeof entry === 'string'
                                ? entry
                                : entry &&
                                  typeof entry === 'object' &&
                                  'command' in entry
                                ? coerceCommandText((entry as any).command)
                                : coerceCommandText(entry),
                        )
                        .filter(Boolean)
                        .join('\n');

                    if (commands) {
                        return commands;
                    }
                }

                return 'Unknown command';
            })();

            const outputText = normalizedItem.outputText ?? '';

            // Check if this is an error message (doesn't start with expected status formats)
            const firstLine = outputText.split('\n')[0]?.trim() || '';
            const isErrorMessage =
                firstLine.includes('error') ||
                firstLine.includes('Error') ||
                firstLine.includes('failed') ||
                firstLine.includes('Failed') ||
                (!firstLine.startsWith('exit ') &&
                    firstLine !== 'timeout' &&
                    outputText &&
                    !outputText.includes('\n'));

            let output: string;
            let success: boolean | undefined;
            let failureReason: string | undefined;

            if (
                isErrorMessage &&
                !firstLine.startsWith('exit ') &&
                firstLine !== 'timeout'
            ) {
                // For error messages, use the entire output
                output = outputText || 'No output';
                success = false;
                failureReason = 'error';
            } else {
                // For normal shell output, parse status line and body
                const [statusLineRaw, ...bodyLines] = outputText.split('\n');
                const statusLine = (statusLineRaw ?? '').trim();
                const bodyText = bodyLines.join('\n').trim();
                output = bodyText || 'No output';

                if (statusLine === 'timeout') {
                    success = false;
                    failureReason = 'timeout';
                } else if (statusLine.startsWith('exit ')) {
                    const parsedExitCode = Number(statusLine.slice(5).trim());
                    success = Number.isFinite(parsedExitCode)
                        ? parsedExitCode === 0
                        : undefined;
                }
            }

            const baseId =
                rawItem?.id ??
                rawItem?.callId ??
                item?.id ??
                item?.callId ??
                `${Date.now()}-${index}`;
            const stableId = `${baseId}-0`;

            messages.push({
                id: stableId,
                sender: 'command',
                command,
                output,
                success,
                failureReason,
                isApprovalRejection,
                ...(callId ? {callId} : {}),
            });
            continue;
        }

        // Handle apply_patch tool
        if (normalizedItem.toolName === APPLY_PATCH_TOOL_NAME) {
            const parsedOutput = safeJsonParse(normalizedItem.outputText);
            const patchOutputItems = parsedOutput?.output ?? [];

            // If JSON parsing failed or no output array, create error message
            if (patchOutputItems.length === 0) {
                const args =
                    normalizeToolArguments(normalizedItem.arguments) ?? {};
                const operationType = args?.type ?? 'unknown';
                const filePath = args?.path ?? 'unknown';
                const command = `apply_patch ${operationType} ${filePath}`;
                const output = normalizedItem.outputText || 'No output';
                const success = false;

                const rawItem = item?.rawItem ?? item;
                const baseId =
                    rawItem?.id ??
                    rawItem?.callId ??
                    item?.id ??
                    item?.callId ??
                    `${Date.now()}-${index}`;
                const stableId = `${baseId}-0`;

                messages.push({
                    id: stableId,
                    sender: 'command',
                    command,
                    output,
                    success,
                    isApprovalRejection,
                    ...(callId ? {callId} : {}),
                });
                continue;
            }

            // Apply patch tool can have multiple operation outputs
            for (const [
                patchIndex,
                patchResult,
            ] of patchOutputItems.entries()) {
                const args =
                    normalizeToolArguments(normalizedItem.arguments) ?? {};
                const operationType =
                    args?.type ?? patchResult?.operation ?? 'unknown';
                const filePath = args?.path ?? patchResult?.path ?? 'unknown';

                const command = `apply_patch ${operationType} ${filePath}`;
                const output =
                    patchResult?.message ?? patchResult?.error ?? 'No output';
                const success = patchResult?.success ?? false;

                const rawItem = item?.rawItem ?? item;
                const baseId =
                    rawItem?.id ??
                    rawItem?.callId ??
                    item?.id ??
                    item?.callId ??
                    `${Date.now()}-${index}`;
                const stableId = `${baseId}-${patchIndex}`;

                messages.push({
                    id: stableId,
                    sender: 'command',
                    command,
                    output,
                    success,
                    isApprovalRejection,
                    ...(callId ? {callId} : {}),
                });
            }
            continue;
        }

        // Handle search tool
        if (normalizedItem.toolName === GREP_TOOL_NAME) {
            const parsedOutput = safeJsonParse(normalizedItem.outputText);
            const rawItem = item?.rawItem ?? item;
            const lookupCallId =
                rawItem?.callId ??
                rawItem?.id ??
                item?.callId ??
                item?.id ??
                callId;
            const fallbackArgs =
                lookupCallId && toolCallArgumentsById.has(lookupCallId)
                    ? toolCallArgumentsById.get(lookupCallId)
                    : null;
            const args =
                normalizeToolArguments(normalizedItem.arguments) ??
                normalizeToolArguments(fallbackArgs) ??
                parsedOutput?.arguments;
            const pattern = args?.pattern ?? '';
            const searchPath = args?.path ?? '.';

            const parts = [`grep "${pattern}"`, `"${searchPath}"`];

            if (args?.case_sensitive) {
                parts.push('--case-sensitive');
            }
            if (args?.file_pattern) {
                parts.push(`--include "${args.file_pattern}"`);
            }
            if (args?.exclude_pattern) {
                parts.push(`--exclude "${args.exclude_pattern}"`);
            }

            const command = parts.join(' ');
            const output =
                parsedOutput?.output ??
                normalizedItem.outputText ??
                'No output';
            // Check if output indicates an error
            const hasError =
                output.toLowerCase().includes('error') ||
                output.toLowerCase().includes('failed');
            const success = !hasError;

            const stableId =
                rawItem?.id ??
                rawItem?.callId ??
                item?.id ??
                item?.callId ??
                `${Date.now()}-${index}`;

            messages.push({
                id: stableId,
                sender: 'command',
                command,
                output,
                success,
                isApprovalRejection,
                ...(callId ? {callId} : {}),
            });
            continue;
        }

        // Handle search_replace tool
        if (normalizedItem.toolName === SEARCH_REPLACE_TOOL_NAME) {
            const parsedOutput = safeJsonParse(normalizedItem.outputText);
            const replaceOutputItems = parsedOutput?.output ?? [];

            // If JSON parsing failed or no output array, create error message
            if (replaceOutputItems.length === 0) {
                const args =
                    normalizeToolArguments(normalizedItem.arguments) ?? {};
                const filePath = args?.path ?? 'unknown';
                const searchContent = args?.search_content ?? '';
                const replaceContent = args?.replace_content ?? '';
                const command = `search_replace "${searchContent}" → "${replaceContent}" "${filePath}"`;
                const output = normalizedItem.outputText || 'No output';
                const success = false;

                const rawItem = item?.rawItem ?? item;
                const baseId =
                    rawItem?.id ??
                    rawItem?.callId ??
                    item?.id ??
                    item?.callId ??
                    `${Date.now()}-${index}`;
                const stableId = `${baseId}-0`;

                messages.push({
                    id: stableId,
                    sender: 'command',
                    command,
                    output,
                    success,
                    isApprovalRejection,
                    toolName: SEARCH_REPLACE_TOOL_NAME,
                    toolArgs: {
                        path: filePath,
                        search_content: searchContent,
                        replace_content: replaceContent,
                        replace_all: args?.replace_all ?? false,
                    },
                    ...(callId ? {callId} : {}),
                });
                continue;
            }

            // Search replace tool can have multiple operation outputs
            for (const [
                replaceIndex,
                replaceResult,
            ] of replaceOutputItems.entries()) {
                const args =
                    normalizeToolArguments(normalizedItem.arguments) ?? {};
                const filePath = args?.path ?? replaceResult?.path ?? 'unknown';
                const searchContent = args?.search_content ?? '';
                const replaceContent = args?.replace_content ?? '';

                const command = `search_replace "${searchContent}" → "${replaceContent}" "${filePath}"`;
                const output =
                    replaceResult?.message ??
                    replaceResult?.error ??
                    'No output';
                const success = replaceResult?.success ?? false;

                const rawItem = item?.rawItem ?? item;
                const baseId =
                    rawItem?.id ??
                    rawItem?.callId ??
                    item?.id ??
                    item?.callId ??
                    `${Date.now()}-${index}`;
                const stableId = `${baseId}-${replaceIndex}`;

                messages.push({
                    id: stableId,
                    sender: 'command',
                    command,
                    output,
                    success,
                    isApprovalRejection,
                    toolName: SEARCH_REPLACE_TOOL_NAME,
                    toolArgs: {
                        path: filePath,
                        search_content: searchContent,
                        replace_content: replaceContent,
                        replace_all: args?.replace_all ?? false,
                    },
                    ...(callId ? {callId} : {}),
                });
            }
            continue;
        }

        // Handle ask_mentor tool
        if (normalizedItem.toolName === ASK_MENTOR_TOOL_NAME) {
            const rawItem = item?.rawItem ?? item;
            const callId = getCallIdFromItem(item);
            const fallbackArgs =
                callId && toolCallArgumentsById.has(callId)
                    ? toolCallArgumentsById.get(callId)
                    : null;
            const args =
                normalizeToolArguments(normalizedItem.arguments) ??
                normalizeToolArguments(fallbackArgs) ??
                {};

            const question = args?.question ?? 'Unknown question';
            const command = `ask_mentor: ${question}`;
            const output =
                normalizedItem.outputText || 'No response from mentor';
            const success = !output.startsWith('Failed to ask mentor:');

            const baseId =
                rawItem?.id ??
                rawItem?.callId ??
                item?.id ??
                item?.callId ??
                `${Date.now()}-${index}`;
            const stableId = `${baseId}-0`;

            messages.push({
                id: stableId,
                sender: 'command',
                command,
                output,
                success,
                isApprovalRejection,
                toolName: ASK_MENTOR_TOOL_NAME,
                toolArgs: args,
                ...(callId ? {callId} : {}),
            });
            continue;
        }
    }

    return messages;
};
