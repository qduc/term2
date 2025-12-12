import React, {FC} from 'react';
import {Box, Text} from 'ink';
import {generateDiff} from '../utils/diff.js';

type Props = {
    approval: any;
};

type ApplyPatchArgs = {
    type: 'create_file' | 'update_file' | 'delete_file';
    path: string;
    diff?: string;
};

type ShellArgs = {
    commands: string;
    timeout_ms?: number;
    max_output_length?: number;
};

type SearchReplaceArgs = {
    path: string;
    search_content: string;
    replace_content: string;
    replace_all?: boolean;
};

const operationLabels: Record<string, {label: string; color: string}> = {
    create_file: {label: 'CREATE', color: 'green'},
    update_file: {label: 'UPDATE', color: 'yellow'},
    delete_file: {label: 'DELETE', color: 'red'},
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
                    <Text dimColor>... ({lines.length - maxLines} more lines)</Text>
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

const ApplyPatchPrompt: FC<{args: ApplyPatchArgs}> = ({args}) => {
    const op = operationLabels[args.type] || {label: args.type, color: 'white'};

    return (
        <Box flexDirection="column">
            <Box>
                <Text color={op.color} bold>
                    [{op.label}]
                </Text>
                <Text> {args.path}</Text>
            </Box>
            {args.diff && <DiffView diff={args.diff} />}
        </Box>
    );
};

const ShellPrompt: FC<{args: ShellArgs}> = ({args}) => {
    return (
        <Box flexDirection="column" marginLeft={2}>
            <Box>
                <Text color="cyan" bold>Command: </Text>
                <Text>{args.commands}</Text>
            </Box>
            {args.timeout_ms && (
                <Box>
                    <Text dimColor>Timeout: {args.timeout_ms}ms</Text>
                </Box>
            )}
            {args.max_output_length && (
                <Box>
                    <Text dimColor>Max output: {args.max_output_length} chars</Text>
                </Box>
            )}
        </Box>
    );
};

const SearchReplacePrompt: FC<{args: SearchReplaceArgs}> = ({args}) => {
    const diff = generateDiff(args.search_content, args.replace_content);

    return (
        <Box flexDirection="column">
            <Box>
                <Text color="yellow" bold>[SEARCH & REPLACE]</Text>
                <Text> {args.path}</Text>
                {args.replace_all && (
                    <Text color="magenta"> (all occurrences)</Text>
                )}
            </Box>
            <DiffView diff={diff} />
        </Box>
    );
};

const ApprovalPrompt: FC<Props> = ({approval}) => {
    // Special handling for max turns exceeded prompt
    if (approval.toolName === 'max_turns_exceeded') {
        return (
            <Box flexDirection="column">
                <Text color="yellow" bold>
                    {approval.argumentsText}
                </Text>
                <Text color="yellow">
                    Do you want to continue? (y/n)
                </Text>
            </Box>
        );
    }

    // Try to parse and render arguments nicely based on tool type
    let content: React.ReactNode = (
        <Text dimColor>{approval.argumentsText}</Text>
    );

    if (approval.toolName === 'apply_patch') {
        try {
            const args: ApplyPatchArgs = JSON.parse(approval.argumentsText);
            content = <ApplyPatchPrompt args={args} />;
        } catch {
            // Fall back to raw JSON if parsing fails
        }
    } else if (approval.toolName === 'shell') {
        try {
            const args: ShellArgs = JSON.parse(approval.argumentsText);
            content = <ShellPrompt args={args} />;
        } catch {
            // Fall back to raw JSON if parsing fails
        }
    } else if (approval.toolName === 'search_replace') {
        try {
            const args: SearchReplaceArgs = JSON.parse(approval.argumentsText);
            content = <SearchReplacePrompt args={args} />;
        } catch {
            // Fall back to raw JSON if parsing fails
        }
    }

    return (
        <Box flexDirection="column">
            <Text color="yellow">
                {approval.agentName} wants to run:{' '}
                <Text bold>{approval.toolName}</Text>
            </Text>
            {content}
            <Text>
                <Text color="yellow">(y/n)</Text>
            </Text>
        </Box>
    );
};

export default ApprovalPrompt;
