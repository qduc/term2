import React, {FC} from 'react';
import {Box, Text} from 'ink';
import {useSetting} from '../hooks/use-setting.js';
import {getProvider} from '../providers/index.js';
import type {SettingsService} from '../services/settings-service.js';

interface StatusBarProps {
    settingsService: SettingsService;
}

const StatusBar: FC<StatusBarProps> = ({settingsService}) => {
    const mode = useSetting<'default' | 'edit'>(settingsService, 'app.mode') ?? 'default';
    const model = useSetting<string>(settingsService, 'agent.model');
    const providerKey = useSetting<string>(settingsService, 'agent.provider') ?? 'openai';
    const reasoningEffort = useSetting<string>(settingsService, 'agent.reasoningEffort') ?? 'default';

    const providerDef = getProvider(providerKey);
    const providerLabel = providerDef?.label || providerKey;

    const slate = '#64748b';
    const glow = '#fbbf24';
    const accent = '#0ed7b5';

    return (
        <Box marginTop={1}>
            <Box marginRight={1}>
                {mode === 'edit' ? (
                    <Text color={glow} bold>Auto Edit</Text>
                ) : (
                    <Text color={slate}>Manual Approval</Text>
                )}
            </Box>

            {model && (
                <>
                    <Text color={slate}>│</Text>
                    <Box marginX={1}>
                        <Text color={accent}>{model}</Text>
                        <Text color={slate}> ({providerLabel})</Text>
                    </Box>
                </>
            )}

            {reasoningEffort && reasoningEffort !== 'default' && (
                <>
                    <Text color={slate}>│</Text>
                    <Box marginX={1}>
                        <Text color={glow}>
                            Reasoning: {reasoningEffort}
                        </Text>
                    </Box>
                </>
            )}
        </Box>
    );
};

export default StatusBar;
