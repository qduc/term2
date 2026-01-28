import React, {FC} from 'react';
import {Box, Text} from 'ink';
import type {SettingCompletionItem} from '../hooks/use-settings-completion.js';

type Props = {
    items: SettingCompletionItem[];
    selectedIndex: number;
    query: string;
};

function titleCaseCategory(category: string): string {
    if (!category || category === 'other') return 'Other Settings';
    if (category === 'common') return 'Common Settings';
    if (category === 'ui') return 'User Interface';
    if (category === 'webSearch') return 'Web Search';
    if (category === 'agent') return 'Agent Configuration';
    if (category === 'openai') return 'OpenAI Provider';
    if (category === 'anthropic') return 'Anthropic Provider';
    if (category === 'openrouter') return 'OpenRouter Provider';
    return category.charAt(0).toUpperCase() + category.slice(1);
}

function getCategoryForKey(key: string): string {
    const COMMON_KEYS = new Set([
        'agent.model',
        'agent.reasoningEffort',
        'agent.temperature',
        'agent.maxTurns',
        'logging.logLevel',
        'shell.timeout',
    ]);
    if (COMMON_KEYS.has(key)) return 'common';
    return key.split('.')[0] || 'other';
}

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, Math.max(0, max - 1)) + '…';
}

function formatValue(value: string | number | boolean): {
    text: string;
    color?: string;
} {
    if (typeof value === 'boolean') {
        return {
            text: value ? 'ON' : 'OFF',
            color: value ? 'green' : 'red',
        };
    }
    if (typeof value === 'number') {
        return {text: String(value), color: 'yellow'};
    }
    return {text: truncate(value, 40), color: 'cyan'};
}

const VISIBLE_COUNT = 15;
const KEY_COL_WIDTH = 32;

const SettingsSelectionMenu: FC<Props> = ({items, selectedIndex, query}) => {
    if (items.length === 0) {
        return (
            <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
                <Text bold color="red">No settings found</Text>
                <Text color="gray">No settings match "{query}"</Text>
            </Box>
        );
    }

    // Calculate viewport
    let viewportStart = 0;
    if (items.length > VISIBLE_COUNT) {
        const half = Math.floor(VISIBLE_COUNT / 2);
        if (selectedIndex <= half) {
            viewportStart = 0;
        } else if (selectedIndex >= items.length - half) {
            viewportStart = items.length - VISIBLE_COUNT;
        } else {
            viewportStart = selectedIndex - half;
        }
    }

    // Ensure start is valid
    viewportStart = Math.max(0, Math.min(viewportStart, items.length - VISIBLE_COUNT));
    // If items < VISIBLE_COUNT, start is 0.

    const visibleItems = items.slice(viewportStart, viewportStart + VISIBLE_COUNT);

    return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
            <Box marginBottom={1} borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} borderTop={false}>
                <Text bold color="cyan">⚙ Settings</Text>
                <Text color="gray"> · </Text>
                {query ? (
                    <Text>Searching: "<Text color="white" bold>{query}</Text>"</Text>
                ) : (
                    <Text color="gray">Type to filter</Text>
                )}
                 <Text color="gray"> · {items.length} items</Text>
            </Box>

            {visibleItems.map((item, index) => {
                const realIndex = viewportStart + index;
                const isSelected = realIndex === selectedIndex;
                const category = getCategoryForKey(item.key);

                // Show header if it's the first item OR if category changes,
                // BUT for the very first item in viewport we usually want a header unless it's a continuation
                // and we want to save space?
                // Let's always show header if it matches the logic, but force it for index 0 of viewport
                // if it's different from the one before viewport (which is handled by category !== prevCategory logic naturally)
                // Wait, if viewport starts at 5, and 4 was 'common', and 5 is 'common', we don't show header?
                // Users might get lost. Let's show header if index==0 in viewport.

                const prevCategory = realIndex > 0 ? getCategoryForKey(items[realIndex - 1]!.key) : null;
                const showHeader = index === 0 || category !== prevCategory;

                const valueObj = item.currentValue !== undefined ? formatValue(item.currentValue) : null;
                const paddedKey = item.key.length > KEY_COL_WIDTH
                    ? truncate(item.key, KEY_COL_WIDTH).padEnd(KEY_COL_WIDTH, ' ')
                    : item.key.padEnd(KEY_COL_WIDTH, ' ');

                return (
                    <Box key={item.key} flexDirection="column">
                        {showHeader && (
                            <Box marginTop={index === 0 ? 0 : 1} marginBottom={0}>
                                <Text color="#22d3ee" bold underline>{titleCaseCategory(category)}</Text>
                            </Box>
                        )}

                        <Box flexDirection="column">
                            <Box>
                                <Text color={isSelected ? 'green' : 'gray'}>
                                    {isSelected ? '▶ ' : '  '}
                                </Text>
                                <Text
                                    color={isSelected ? 'green' : 'white'}
                                    bold={isSelected}
                                >
                                    {paddedKey}
                                </Text>
                                {valueObj && (
                                    <Text color={isSelected ? 'white' : 'gray'}>
                                         {valueObj.text}
                                    </Text>
                                )}
                            </Box>

                            {isSelected && item.description && (
                                <Box marginLeft={2} marginTop={0}>
                                    <Text color="#7dd3fc" dimColor italic>
                                        └── {item.description}
                                    </Text>
                                </Box>
                            )}
                        </Box>
                    </Box>
                );
            })}

            <Box marginTop={1} borderStyle="single" borderTop={true} borderBottom={false} borderLeft={false} borderRight={false} borderColor="gray">
                <Text color="gray" dimColor>
                    Use <Text bold>↑↓</Text> to navigate, <Text bold>Enter</Text> to edit, <Text bold>Esc</Text> to close
                </Text>
            </Box>
        </Box>
    );
};

export default SettingsSelectionMenu;
