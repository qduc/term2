import React, {FC} from 'react';
import {Box, Text} from 'ink';
import type {ModelInfo} from '../services/model-service.js';

type Props = {
    items: ModelInfo[];
    selectedIndex: number;
    query: string;
    provider?: 'openai' | 'openrouter' | null;
    loading?: boolean;
    error?: string | null;
};

const ProviderTabs: FC<{activeProvider?: 'openai' | 'openrouter' | null}> = ({
    activeProvider,
}) => {
    const providers: Array<{id: 'openai' | 'openrouter'; label: string}> = [
        {id: 'openai', label: 'OpenAI'},
        {id: 'openrouter', label: 'OpenRouter'},
    ];

    return (
        <Box justifyContent="space-between">
            <Box>
                {providers.map((provider, index) => {
                    const isActive = provider.id === activeProvider;
                    return (
                        <Box key={provider.id}>
                            <Text
                                inverse={isActive}
                                color={isActive ? 'magenta' : 'gray'}
                                bold={isActive}
                                dimColor={!isActive}
                            >
                                {' '}
                                {provider.label}
                                {' '}
                            </Text>
                            {index < providers.length - 1 && (
                                <Text color="gray" dimColor>
                                    {' │ '}
                                </Text>
                            )}
                        </Box>
                    );
                })}
            </Box>
            <Text color="gray" dimColor>
                Tab → switch provider
            </Text>
        </Box>
    );
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
            <ProviderTabs activeProvider={provider} />
            <Box
                borderStyle="round"
                borderColor="magenta"
                paddingX={1}
                flexDirection="column"
            >
                <Text color="gray" dimColor>
                    {items.length} suggestion{items.length === 1 ? '' : 's'}
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
                Enter → set model · Esc → cancel
            </Text>
        </Box>
    );
};

export default ModelSelectionMenu;
