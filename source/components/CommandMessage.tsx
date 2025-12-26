import React, {FC} from 'react';
import {Box, Text} from 'ink';
import {generateDiff} from '../utils/diff.js';

type Props = {
    command: string;
    output?: string;
    status?: 'pending' | 'running' | 'completed' | 'failed';
    success?: boolean | null;
    failureReason?: string;
    toolName?: string;
    toolArgs?: any;
    isApprovalRejection?: boolean;
    hadApproval?: boolean;
};

const DiffView: FC<{diff: string}> = ({diff}) => {
    try {
        const lines = diff.split('\n');
        const maxLines = 30;
        const truncated = lines.length > maxLines;
        const displayLines = truncated ? lines.slice(0, maxLines) : lines;

        return (
            <Box flexDirection="column" marginLeft={2}>
                {displayLines.map((line, i) => {
                    let color: string | undefined;
                    if (line.startsWith('+')) {
                        color = 'green';
                    } else if (line.startsWith('-')) {
                        color = 'red';
                    } else if (line.startsWith('@@')) {
                        color = 'cyan';
                    }

                    return (
                        <Text key={i} color={color} dimColor={!color}>
                            {line}
                        </Text>
                    );
                })}
                {truncated && (
                    <Text dimColor>
                        ... ({lines.length - maxLines} more lines)
                    </Text>
                )}
            </Box>
        );
    } catch (error) {
        return (
            <Box marginLeft={2}>
                <Text color="red" dimColor>
                    [Failed to render diff preview]
                </Text>
            </Box>
        );
    }
};

const formatToolArgs = (toolName: string | undefined, args: any): string => {
    if (!args || !toolName) {
        return '';
    }

    const normalizedArgs: any = (() => {
        if (typeof args !== 'string') {
            return args;
        }

        const trimmed = args.trim();
        if (!trimmed) {
            return null;
        }

        try {
            return JSON.parse(trimmed);
        } catch {
            return null;
        }
    })();

    if (!normalizedArgs || typeof normalizedArgs !== 'object') {
        return '';
    }

    try {
        // Format based on tool type to match extract-command-messages.ts
        switch (toolName) {
            case 'shell': {
                const command = normalizedArgs.command ?? normalizedArgs.commands;

                const commandText =
                    typeof command === 'string'
                        ? command
                        : Array.isArray(command)
                            ? command.join(' && ')
                            : '';

                if (typeof commandText === 'string' && commandText.trim()) {
                    return commandText.length > 80
                        ? `${commandText.slice(0, 80)}...`
                        : commandText;
                }
                return '';
            }

            case 'grep': {
                const pattern = normalizedArgs.pattern || '';
                const path = normalizedArgs.path || '.';
                const parts = [`"${pattern}"`, `"${path}"`];

                if (normalizedArgs.case_sensitive) parts.push('--case-sensitive');
                if (normalizedArgs.file_pattern) parts.push(`--include "${normalizedArgs.file_pattern}"`);
                if (normalizedArgs.exclude_pattern) parts.push(`--exclude "${normalizedArgs.exclude_pattern}"`);

                return parts.join(' ');
            }

            case 'apply_patch': {
                const type = normalizedArgs.type || 'unknown';
                const path = normalizedArgs.path || 'unknown';
                return `${type} ${path}`;
            }

            case 'search_replace': {
                const searchContent = normalizedArgs.search_content || '';
                const replaceContent = normalizedArgs.replace_content || '';
                const path = normalizedArgs.path || 'unknown';
                const search = searchContent.length > 30
                    ? `${searchContent.slice(0, 30)}...`
                    : searchContent;
                const replace = replaceContent.length > 30
                    ? `${replaceContent.slice(0, 30)}...`
                    : replaceContent;
                return `"${search}" → "${replace}" "${path}"`;
            }

            case 'ask_mentor': {
                const question = normalizedArgs.question || 'Unknown question';
                return question.length > 80
                    ? `${question.slice(0, 80)}...`
                    : question;
            }

            default:
                // Generic fallback for unknown tools
                const entries = Object.entries(normalizedArgs);
                if (entries.length === 0) return '';

                return entries
                    .map(([key, value]) => {
                        const stringValue = typeof value === 'string'
                            ? (value.length > 50 ? `${value.slice(0, 50)}...` : value)
                            : JSON.stringify(value);
                        return `${key}=${stringValue}`;
                    })
                    .join(' ');
        }
    } catch {
        return '';
    }
};

const CommandMessage: FC<Props> = ({
    command,
    output,
    status,
    success,
    failureReason,
    toolName,
    toolArgs,
    hadApproval,
}) => {
    const isRunning = status === 'pending' || status === 'running';
    const outputText = output?.trim() ? output : (isRunning ? '(running...)' : '(no output)');
    const displayed =
        outputText && outputText !== '(no output)'
            ? (() => {
                  const lines = (output || '').split('\n');
                  return lines.length > 3
                      ? `${lines.slice(0, 3).join('\n')}\n... (${
                            lines.length - 3
                        } more lines)`
                      : output;
              })()
            : outputText;

    // Special handling for search_replace
    if (toolName === 'search_replace' && toolArgs) {
        const diff = generateDiff(
            toolArgs.search_content,
            toolArgs.replace_content,
        );

        // For search_replace that had an approval prompt (user said 'y'), only show output
        if (hadApproval) {
            return (
                <Box flexDirection="column">
                    <Text color={success === false ? 'red' : 'gray'}>
                        {displayed}
                    </Text>
                </Box>
            );
        }

        // For auto-approved search_replace (no approval prompt), show diff + output
        return (
            <Box flexDirection="column">
                <Box>
                    <Text color="yellow" bold>
                        [SEARCH & REPLACE]
                    </Text>
                    <Text> {toolArgs.path}</Text>
                    {toolArgs.replace_all && (
                        <Text color="magenta"> (all occurrences)</Text>
                    )}
                </Box>
                <DiffView diff={diff} />
                {failureReason && (
                    <Text color="red">Error: {failureReason}</Text>
                )}
                <Text color={success === false ? 'red' : 'gray'}>
                    {displayed}
                </Text>
            </Box>
        );
    }

    const formattedArgs = toolArgs ? formatToolArgs(toolName, toolArgs) : '';

    return (
        <Box flexDirection="column">
            <Text color={success === false ? 'red' : isRunning ? 'yellow' : 'cyan'}>
                $ <Text bold>{command}</Text>
                {isRunning && formattedArgs && <Text color="yellow"> {formattedArgs}</Text>}
            </Text>
            {failureReason && <Text color="red">Error: {failureReason}</Text>}
            <Text color={success === false ? 'red' : 'gray'}>{displayed}</Text>
        </Box>
    );
};

export default React.memo(CommandMessage);
