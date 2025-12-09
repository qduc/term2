import React, {FC} from 'react';
import {Box, Text} from 'ink';
import {settingsService} from '../services/settings-service.js';

const accent = '#0ed7b5';
const glow = '#fbbf24';
const slate = '#94a3b8';

const Banner: FC = () => {
    const mode = settingsService.get<'default' | 'edit'>('app.mode') ?? 'default';
    const model = settingsService.get<string>('agent.model');

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={accent}
            paddingX={2}
            paddingY={1}
            marginBottom={1}
        >
            <Box>
                <Text color={accent} bold>
                    term
                </Text>
                <Text color={glow} bold>
                    ²
                </Text>
                <Text color={slate}> — terminal-native AI cockpit</Text>
            </Box>

            <Box marginTop={0}>
                <Text color={accent}>▚▞ </Text>
                <Text color={glow}>stream</Text>
                <Text color="gray"> · </Text>
                <Text color={glow}>approve</Text>
                <Text color="gray"> · </Text>
                <Text color={glow}>edit</Text>
                <Text color="gray"> · </Text>
                <Text color={glow}>ship</Text>
                <Text color="gray"> — stay in flow without leaving the shell</Text>
            </Box>

            <Box marginTop={0}>
                <Text color="gray" dimColor>
                    mode
                </Text>
                <Text color="gray">: </Text>
                <Text color={accent} bold>
                    {mode}
                </Text>
                {model && (
                    <>
                        <Text color="gray"> · model: </Text>
                        <Text color={glow}>
                            {model}
                        </Text>
                    </>
                )}
                <Text color="gray"> · Shift+Tab toggles mode · /help for commands</Text>
            </Box>
        </Box>
    );
};

export default Banner;