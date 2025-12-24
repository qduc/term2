import React, {FC} from 'react';
import {Box, Text} from 'ink';
import {generateDiff} from '../utils/diff.js';

type Props = {
    command: string;
    output?: string;
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

const CommandMessage: FC<Props> = ({
    command,
    output,
    success,
    failureReason,
    toolName,
    toolArgs,
    hadApproval,
}) => {
    const outputText = output?.trim() ? output : '(no output)';
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
        const diff = generateDiff(toolArgs.search_content, toolArgs.replace_content);

        // For search_replace that had an approval prompt (user said 'y'), only show output
        if (hadApproval) {
            return (
                <Box flexDirection="column">
                    <Text color={success === false ? 'red' : 'gray'}>{displayed}</Text>
                </Box>
            );
        }

        // For auto-approved search_replace (no approval prompt), show diff + output
        return (
            <Box flexDirection="column">
                <Box>
                    <Text color="yellow" bold>[SEARCH & REPLACE]</Text>
                    <Text> {toolArgs.path}</Text>
                    {toolArgs.replace_all && (
                        <Text color="magenta"> (all occurrences)</Text>
                    )}
                </Box>
                <DiffView diff={diff} />
                {failureReason && <Text color="red">Error: {failureReason}</Text>}
                <Text color={success === false ? 'red' : 'gray'}>{displayed}</Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            <Text color={success === false ? 'red' : 'cyan'}>
                $ <Text bold>{command}</Text>
            </Text>
            {failureReason && <Text color="red">Error: {failureReason}</Text>}
            <Text color={success === false ? 'red' : 'gray'}>{displayed}</Text>
        </Box>
    );
};

export default React.memo(CommandMessage);
