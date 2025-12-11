const SHELL_TOOL_NAME = 'shell';
const GREP_TOOL_NAME = 'grep';
const APPLY_PATCH_TOOL_NAME = 'apply_patch';
const SEARCH_REPLACE_TOOL_NAME = 'search_replace';

const approvalRejectionCallIds = new Set<string>();

const getCallIdFromItem = (item: any): string | null => {
    const rawItem = item?.rawItem ?? item;
    if (!rawItem) {
        return null;
    }

    return (
        rawItem.callId ??
        rawItem.id ??
        item?.callId ??
        item?.id ??
        null
    );
};

export const markToolCallAsApprovalRejection = (callId?: string | null): void => {
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
        return value.map(part => coerceToText(part)).filter(Boolean).join('\n');
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
        rawItem?.type === 'function_call_result';
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

        const callId = rawItem.callId ?? rawItem.id;
        if (!callId) {
            continue;
        }

        const args = rawItem.arguments ?? rawItem.args ?? item?.arguments ?? item?.args;
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

        // Handle shell tool
        if (normalizedItem.toolName === SHELL_TOOL_NAME) {
            const rawItem = item?.rawItem ?? item;
            const callId = rawItem?.callId ?? rawItem?.id ?? item?.callId ?? item?.id;
            const fallbackArgs =
                callId && toolCallArgumentsById.has(callId)
                    ? toolCallArgumentsById.get(callId)
                    : null;
            const args =
                normalizeToolArguments(normalizedItem.arguments) ??
                normalizeToolArguments(fallbackArgs) ??
                {};
            const command =
                coerceCommandText((args as any)?.commands) ||
                coerceCommandText((args as any)?.command) ||
                'Unknown command';

            const outputText = normalizedItem.outputText ?? '';
            const [statusLineRaw, ...bodyLines] = outputText.split('\n');
            const statusLine = (statusLineRaw ?? '').trim();
            const bodyText = bodyLines.join('\n').trim();
            const output = bodyText || 'No output';

            let success: boolean | undefined;
            let failureReason: string | undefined;

            if (statusLine === 'timeout') {
                success = false;
                failureReason = 'timeout';
            } else if (statusLine.startsWith('exit ')) {
                const parsedExitCode = Number(statusLine.slice(5).trim());
                success = Number.isFinite(parsedExitCode)
                    ? parsedExitCode === 0
                    : undefined;
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
            });
            continue;
        }

        // Handle apply_patch tool
        if (normalizedItem.toolName === APPLY_PATCH_TOOL_NAME) {
            const parsedOutput = safeJsonParse(normalizedItem.outputText);
            const patchOutputItems = parsedOutput?.output ?? [];

            // Apply patch tool can have multiple operation outputs
            for (const [patchIndex, patchResult] of patchOutputItems.entries()) {
                const args = normalizeToolArguments(normalizedItem.arguments) ?? {};
                const operationType = args?.type ?? patchResult?.operation ?? 'unknown';
                const filePath = args?.path ?? patchResult?.path ?? 'unknown';

                const command = `apply_patch ${operationType} ${filePath}`;
                const output = patchResult?.message ?? patchResult?.error ?? 'No output';
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
                });
            }
            continue;
        }

        // Handle search tool
        if (normalizedItem.toolName === GREP_TOOL_NAME) {
            const parsedOutput = safeJsonParse(normalizedItem.outputText);
            const rawItem = item?.rawItem ?? item;
            const callId = rawItem?.callId ?? rawItem?.id ?? item?.callId ?? item?.id;
            const fallbackArgs =
                callId && toolCallArgumentsById.has(callId)
                    ? toolCallArgumentsById.get(callId)
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
            const output = parsedOutput?.output ?? normalizedItem.outputText ?? 'No output';
            const success = true;

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
            });
            continue;
        }

        // Handle search_replace tool
        if (normalizedItem.toolName === SEARCH_REPLACE_TOOL_NAME) {
            const parsedOutput = safeJsonParse(normalizedItem.outputText);
            const replaceOutputItems = parsedOutput?.output ?? [];

            // Search replace tool can have multiple operation outputs
            for (const [replaceIndex, replaceResult] of replaceOutputItems.entries()) {
                const args = normalizeToolArguments(normalizedItem.arguments) ?? {};
                const filePath = args?.path ?? replaceResult?.path ?? 'unknown';
                const searchContent = args?.search_content ?? '';
                const replaceContent = args?.replace_content ?? '';

                const command = `search_replace "${searchContent}" → "${replaceContent}" "${filePath}"`;
                const output = replaceResult?.message ?? replaceResult?.error ?? 'No output';
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
                });
            }
            continue;
        }
    }

    return messages;
};
