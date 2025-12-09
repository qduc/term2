import React, {FC} from 'react';
import {Box, Text} from 'ink';
import type {ModelInfo} from '../services/model-service.js';

type Props = {
    items: ModelInfo[];
    selectedIndex: number;
    query: string;
    provider?: string | null;
    loading?: boolean;
    error?: string | null;
};

const ModelSelectionMenu: FC<Props> = ({
    items,
    selectedIndex,
    query,
    provider,
    loading = false,
    error = null,
}) => {
    if (loading) {
        return (
            <Box borderStyle="round" borderColor="magenta" paddingX={1}>
                <Text color="magenta">
                    Loading models{provider ? ` from ${provider}` : ''}…
                </Text>
            </Box>
        );
    }

    if (error) {
        return (
            <Box borderStyle="round" borderColor="red" paddingX={1}>
                <Text color="red">Unable to load models: {error}</Text>
            </Box>
        );
    }

    if (items.length === 0) {
        return (
            <Box borderStyle="round" borderColor="magenta" paddingX={1}>
                <Text color="gray" dimColor>
                    No models match "{query || '*'}"
                </Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            <Box
                borderStyle="round"
                borderColor="magenta"
                paddingX={1}
                flexDirection="column"
            >
                <Text color="gray" dimColor>
                    {provider ? `${provider} models` : 'Models'} · {items.length} suggestion
                    {items.length === 1 ? '' : 's'}
                </Text>
                {items.map((item, index) => {
                    const isSelected = index === selectedIndex;
                    return (
                        <Box key={item.id}>
                            <Text
                                inverse={isSelected}
                                color={isSelected ? 'magenta' : undefined}
                                bold={isSelected}
                            >
                                {item.id}
                            </Text>
                            {item.name && (
                                <Text color={isSelected ? 'white' : 'gray'} dimColor={!isSelected}>
                                    {' '}
                                    — {item.name}
                                </Text>
                            )}
                        </Box>
                    );
                })}
            </Box>
            <Text color="gray" dimColor>
                Enter → set model · Tab → insert and keep editing · Esc → cancel
            </Text>
        </Box>
    );
};

export default ModelSelectionMenu;
