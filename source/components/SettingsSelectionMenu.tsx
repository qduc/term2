import React, {FC} from 'react';
import {Box, Text} from 'ink';
import type {SettingCompletionItem} from '../hooks/use-settings-completion.js';

type Props = {
    items: SettingCompletionItem[];
    selectedIndex: number;
};

const SettingsSelectionMenu: FC<Props> = ({items, selectedIndex}) => {
    if (items.length === 0) {
        return null;
    }

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="green"
            paddingX={1}
            marginBottom={0}
        >
            <Text bold color="green" underline>
                Select Setting:
            </Text>
            {items.map((item, index) => (
                <Box key={item.key}>
                    <Text
                        color={index === selectedIndex ? 'green' : undefined}
                        bold={index === selectedIndex}
                        inverse={index === selectedIndex}
                    >
                        {item.key}
                    </Text>
                    {item.currentValue !== undefined && (
                        <Text color="yellow">
                            {' '}
                            = {String(item.currentValue)}
                        </Text>
                    )}
                    {item.description && (
                        <Text color="gray" dimColor>
                            {' '}
                            - {item.description}
                        </Text>
                    )}
                </Box>
            ))}
        </Box>
    );
};

export default SettingsSelectionMenu;
