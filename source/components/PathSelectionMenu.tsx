import React, {FC} from 'react';
import {Box, Text} from 'ink';
import type {PathCompletionItem} from '../hooks/use-path-completion.js';

type Props = {
    items: PathCompletionItem[];
    selectedIndex: number;
    query: string;
    loading?: boolean;
    error?: string | null;
};

const PathSelectionMenu: FC<Props> = ({
    items,
    selectedIndex,
    query,
    loading = false,
    error = null,
}) => {
    if (loading) {
        return (
            <Box
                borderStyle="round"
                borderColor="cyan"
                paddingX={1}
                flexDirection="column"
            >
                <Text color="cyan">Loading project paths…</Text>
            </Box>
        );
    }

    if (error) {
        return (
            <Box
                borderStyle="round"
                borderColor="red"
                paddingX={1}
                flexDirection="column"
            >
                <Text color="red">Unable to load paths: {error}</Text>
            </Box>
        );
    }

    if (items.length === 0) {
        return (
            <Box
                borderStyle="round"
                borderColor="cyan"
                paddingX={1}
                flexDirection="column"
            >
                <Text color="#64748b">
                    No matches for "@{query}"
                </Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            <Box
                borderStyle="round"
                borderColor="cyan"
                paddingX={1}
                flexDirection="column"
            >
                <Text color="#64748b">
                    @{query || '*'} · {items.length} suggestion
                    {items.length === 1 ? '' : 's'}
                </Text>
                {items.map((item, index) => {
                    const isSelected = index === selectedIndex;
                    const icon = item.type === 'directory' ? '📁' : '📄';
                    return (
                        <Box key={item.path}>
                            <Text
                                color={isSelected ? 'cyan' : undefined}
                                inverse={isSelected}
                            >
                                {icon} {item.path}
                            </Text>
                        </Box>
                    );
                })}
            </Box>
            <Text color="#64748b">
                Enter → insert with space · Tab → insert w/o trailing space ·
                Esc → cancel
            </Text>
        </Box>
    );
};

export default PathSelectionMenu;
