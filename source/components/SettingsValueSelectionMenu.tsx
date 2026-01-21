import React, {FC} from 'react';
import {Box, Text} from 'ink';
import type {SettingValueSuggestion} from '../hooks/use-settings-value-completion.js';

type Props = {
    settingKey: string;
    items: SettingValueSuggestion[];
    selectedIndex: number;
    query: string;
};

const SettingsValueSelectionMenu: FC<Props> = ({
    settingKey,
    items,
    selectedIndex,
    query,
}) => {
    if (items.length === 0) {
        return (
            <Box flexDirection="column">
                <Box
                    borderStyle="round"
                    borderColor="green"
                    paddingX={1}
                    flexDirection="column"
                >
                    <Text color="gray" dimColor>
                        {settingKey} · No values match "{query || '*'}"
                    </Text>
                </Box>
                <Text color="gray" dimColor>
                    Enter → apply typed value · Esc → cancel · ↑↓ → navigate
                </Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            <Box
                borderStyle="round"
                borderColor="green"
                paddingX={1}
                flexDirection="column"
            >
                <Text color="gray" dimColor>
                    {settingKey} · "{query || '*'}" · {items.length} suggestion
                    {items.length === 1 ? '' : 's'}
                </Text>
                {items.map((item, index) => {
                    const isSelected = index === selectedIndex;
                    return (
                        <Box key={item.value}>
                            <Text
                                color={isSelected ? 'green' : undefined}
                                inverse={isSelected}
                            >
                                {isSelected ? '▶ ' : '  '}
                                {item.value}
                            </Text>
                            {item.description && (
                                <Text color="gray" dimColor>
                                    {' '}
                                    — {item.description}
                                </Text>
                            )}
                        </Box>
                    );
                })}
            </Box>
            <Text color="gray" dimColor>
                Enter → set value · Tab → insert value · Esc → cancel · ↑↓ →
                navigate
            </Text>
        </Box>
    );
};

export default SettingsValueSelectionMenu;
