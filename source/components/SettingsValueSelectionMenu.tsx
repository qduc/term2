import React, {FC} from 'react';
import {Box, Text} from 'ink';
import type {SettingValueSuggestion} from '../hooks/use-settings-value-completion.js';

type Props = {
    settingKey: string;
    items: SettingValueSuggestion[];
    selectedIndex: number;
    query: string;
    isNumericSettings?: boolean;
};

const VISIBLE_COUNT = 10;

const SettingsValueSelectionMenu: FC<Props> = ({
    settingKey,
    items,
    selectedIndex,
    query,
    isNumericSettings,
}) => {
    if (items.length === 0) {
        return (
            <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
                <Text color="red" bold>No matching values</Text>
                <Text color="gray">
                    {settingKey} · No values match "{query || '*'}"
                </Text>
                {isNumericSettings && (
                     <Text color="yellow">Note: This setting accepts numeric values.</Text>
                )}
                <Box marginTop={1}>
                     <Text color="gray">
                        Enter → apply typed value · Esc → cancel
                    </Text>
                </Box>
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
    viewportStart = Math.max(0, Math.min(viewportStart, items.length - VISIBLE_COUNT));
    const visibleItems = items.slice(viewportStart, viewportStart + VISIBLE_COUNT);

    return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
            <Box marginBottom={1} borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} borderTop={false}>
                <Text color="gray">Value for </Text>
                <Text color="cyan" bold>{settingKey}</Text>
                <Text color="gray"> · </Text>
                {query ? (
                     <Text>Filter: "<Text color="white" bold>{query}</Text>"</Text>
                ) : (
                    <Text color="gray">
                        {isNumericSettings ? 'Select or type custom value' : 'Select a value'}
                    </Text>
                )}
            </Box>

            {visibleItems.map((item, index) => {
                const realIndex = viewportStart + index;
                const isSelected = realIndex === selectedIndex;

                return (
                    <Box key={item.value}>
                        <Text
                            color={isSelected ? 'green' : 'gray'}
                        >
                            {isSelected ? '▶ ' : '  '}
                        </Text>
                        <Text color={isSelected ? 'green' : 'white'} bold={isSelected}>
                            {item.value}
                        </Text>
                        {item.description && (
                            <Text color="gray">
                                {' '}
                                — {item.description}
                            </Text>
                        )}
                    </Box>
                );
            })}

            <Box marginTop={1} borderStyle="single" borderTop={true} borderBottom={false} borderLeft={false} borderRight={false} borderColor="gray">
                <Text color="gray" dimColor>
                    <Text bold>Enter</Text> confirm · <Text bold>Esc</Text> cancel · <Text bold>↑↓</Text> navigate
                </Text>
            </Box>
        </Box>
    );
};

export default SettingsValueSelectionMenu;
