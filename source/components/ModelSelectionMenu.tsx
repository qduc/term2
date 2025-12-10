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
    scrollOffset?: number;
    maxHeight?: number;
    canSwitchProvider?: boolean;
};

const ProviderTabs: FC<{
    activeProvider?: 'openai' | 'openrouter' | null;
    canSwitch?: boolean;
}> = ({activeProvider, canSwitch = true}) => {
    const providers: Array<{id: 'openai' | 'openrouter'; label: string}> = [
        {id: 'openai', label: 'OpenAI'},
        {id: 'openrouter', label: 'OpenRouter'},
    ];

    return (
        <Box flexDirection="column">
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
                {canSwitch && (
                    <Text color="gray" dimColor>
                        Tab → switch provider
                    </Text>
                )}
            </Box>
            {!canSwitch && (
                <Box marginTop={0}>
                    <Text color="yellow" dimColor>
                        ⚠ Provider can only be changed at the start of a new
                        conversation (/clear to reset)
                    </Text>
                </Box>
            )}
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
    scrollOffset = 0,
    maxHeight = 10,
    canSwitchProvider = true,
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

    const visibleItems = items.slice(scrollOffset, scrollOffset + maxHeight);
    const hasScrollUp = scrollOffset > 0;
    const hasScrollDown = scrollOffset + maxHeight < items.length;

    return (
        <Box flexDirection="column">
            <ProviderTabs
                activeProvider={provider}
                canSwitch={canSwitchProvider}
            />
            <Box
                borderStyle="round"
                borderColor="magenta"
                paddingX={1}
                flexDirection="column"
            >
                <Box justifyContent="space-between">
                    <Text color="gray" dimColor>
                        {items.length} suggestion{items.length === 1 ? '' : 's'}
                    </Text>
                    {items.length > maxHeight && (
                        <Text color="gray" dimColor>
                            {scrollOffset + 1}-{Math.min(scrollOffset + maxHeight, items.length)}/{items.length}
                        </Text>
                    )}
                </Box>
                {hasScrollUp && (
                    <Text color="gray" dimColor>
                        ↑ {scrollOffset} more
                    </Text>
                )}
                {visibleItems.map((item, visibleIndex) => {
                    const actualIndex = scrollOffset + visibleIndex;
                    const isSelected = actualIndex === selectedIndex;
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
                {hasScrollDown && (
                    <Text color="gray" dimColor>
                        ↓ {items.length - scrollOffset - maxHeight} more
                    </Text>
                )}
            </Box>
            <Text color="gray" dimColor>
                Enter → set model · Esc → cancel · ↑↓ → scroll
            </Text>
        </Box>
    );
};

export default ModelSelectionMenu;
