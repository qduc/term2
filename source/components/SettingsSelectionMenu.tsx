import React, {FC} from 'react';
import {Box, Text, useStdout} from 'ink';
import type {SettingCompletionItem} from '../hooks/use-settings-completion.js';

type Props = {
    items: SettingCompletionItem[];
    selectedIndex: number;
    query: string;
};

function titleCaseCategory(category: string): string {
    if (!category) return 'Other';
    if (category === 'ui') return 'UI';
    if (category === 'webSearch') return 'Web Search';
    return category.charAt(0).toUpperCase() + category.slice(1);
}

function getCategoryForKey(key: string): string {
    // Common keys are placed first by buildSettingsList sorting.
    // We still label them as "Common" in the UI for discoverability.
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

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
}

function formatValue(value: string | number | boolean): {
    text: string;
    color?: string;
} {
    if (typeof value === 'boolean') {
        return {
            text: value ? 'on' : 'off',
            color: value ? 'green' : 'gray',
        };
    }
    if (typeof value === 'number') {
        return {text: String(value), color: 'yellow'};
    }

    // string
    return {text: truncate(value, 40), color: 'yellow'};
}

const KEY_COL_WIDTH = 28;

const SettingsSelectionMenu: FC<Props> = ({items, selectedIndex, query}) => {
    const {stdout} = useStdout();
    const stdoutWidth = stdout?.columns ?? 80;
    // Conservative estimate of available content width inside a rounded box with paddingX={1}.
    // 2 columns for borders + 2 for padding + a little slack.
    const contentWidth = Math.max(20, stdoutWidth - 6);

    // Reserve space for marker + key column and at least one space.
    const markerWidth = 2; // "▶ " or "  "
    const keyWidth = KEY_COL_WIDTH;
    const gapAfterKey = 1;
    const valueMax = clamp(contentWidth - (markerWidth + keyWidth + gapAfterKey), 8, 48);
    const descIndent = markerWidth + keyWidth;
    const descMax = clamp(contentWidth - descIndent, 10, 80);

    if (items.length === 0) {
        return (
            <Box flexDirection="column">
                <Box
                    flexDirection="column"
                    borderStyle="round"
                    borderColor="green"
                    paddingX={1}
                    marginBottom={0}
                >
                    <Text color="gray" dimColor>
                        settings: "{query || '*'}" · No settings match
                    </Text>
                    <Text color="gray" dimColor>
                        Try searching by key (e.g. "shell") or description
                        (e.g. "timeout")
                    </Text>
                </Box>
                <Text color="gray" dimColor>
                    Esc → cancel · ↑↓ → navigate
                </Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="green"
                paddingX={1}
                marginBottom={0}
            >
                <Text color="gray" dimColor>
                    settings: "{query || '*'}" · {items.length} suggestion
                    {items.length === 1 ? '' : 's'}
                </Text>
                {items.map((item, index) => {
                    const isSelected = index === selectedIndex;
                    const category = getCategoryForKey(item.key);
                    const prevCategory =
                        index > 0
                            ? getCategoryForKey(items[index - 1]!.key)
                            : null;
                    const categoryHeader =
                        category !== prevCategory ? (
                            <Box>
                                <Text color="gray" dimColor>
                                    {titleCaseCategory(category)}
                                </Text>
                            </Box>
                        ) : null;

                    const paddedKey = truncate(item.key, KEY_COL_WIDTH).padEnd(KEY_COL_WIDTH, ' ');
                    const value =
                        item.currentValue !== undefined
                            ? formatValue(item.currentValue)
                            : null;
                    const description = item.description
                        ? truncate(item.description, descMax)
                        : '';
                    const valueText = value ? truncate(value.text, valueMax) : '';

                    return (
                        <Box key={item.key} flexDirection="column">
                            {categoryHeader}
                            <Box>
                                <Text
                                    color={isSelected ? 'green' : undefined}
                                    inverse={isSelected}
                                >
                                    {isSelected ? '▶ ' : '  '}
                                    {paddedKey}
                                </Text>
                                <Text>{' '}</Text>
                                {value && (
                                    <Text color={value.color as any}>
                                        {valueText}
                                    </Text>
                                )}
                            </Box>
                            {description && (
                                <Box>
                                    <Text color="gray" dimColor>
                                        {''.padEnd(descIndent, ' ')}
                                        {description}
                                    </Text>
                                </Box>
                            )}
                        </Box>
                    );
                })}
            </Box>
            <Text color="gray" dimColor>
                Enter → insert key · Tab → insert key · Esc → cancel · ↑↓ →
                navigate
            </Text>
        </Box>
    );
};

export default SettingsSelectionMenu;
