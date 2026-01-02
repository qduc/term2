import React, {FC} from 'react';
import {Box, Text} from 'ink';
import {useSetting} from '../hooks/use-setting.js';
import {getProvider} from '../providers/index.js';
import type {SettingsService} from '../services/settings-service.js';

interface StatusBarProps {
    settingsService: SettingsService;
    isShellMode?: boolean;
}

const StatusBar: FC<StatusBarProps> = ({settingsService, isShellMode = false}) => {
    const mentorMode = useSetting<boolean>(settingsService, 'app.mentorMode') ?? false;
    const editMode = useSetting<boolean>(settingsService, 'app.editMode') ?? false;
    const liteMode = useSetting<boolean>(settingsService, 'app.liteMode') ?? false;
    const model = useSetting<string>(settingsService, 'agent.model');
    const mentorModel = useSetting<string>(settingsService, 'agent.mentorModel');
    const providerKey =
        useSetting<string>(settingsService, 'agent.provider') ?? 'openai';
    const reasoningEffort =
        useSetting<string>(settingsService, 'agent.reasoningEffort') ??
        'default';

    const providerDef = getProvider(providerKey);
    const providerLabel = providerDef?.label || providerKey;

    const slate = '#64748b';
    const glow = '#fbbf24';
    const accent = '#0ed7b5';

    return (
        <Box marginTop={1}>
            <Box marginRight={1} gap={1}>
                {liteMode && (
                    <>
                        <Text color="#10b981" bold>
                            Lite
                        </Text>
                        <Text color={isShellMode ? '#ca8a04' : '#3b82f6'} bold>
                            {isShellMode ? 'Shell' : 'Ask'}
                        </Text>
                    </>
                )}
                {editMode && (
                    <Text color={glow} bold>
                        Edit
                    </Text>
                )}
                {mentorMode && (
                    <Text color="#a78bfa" bold>
                        Mentor
                    </Text>
                )}
                {!editMode && !mentorMode && !liteMode && (
                    <Text color={slate}>Default</Text>
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

            {mentorMode && mentorModel && (
                <>
                    <Text color={slate}>│</Text>
                    <Box marginX={1}>
                        <Text color={slate}>Mentor: </Text>
                        <Text color="#a78bfa">{mentorModel}</Text>
                    </Box>
                </>
            )}

            {reasoningEffort && reasoningEffort !== 'default' && (
                <>
                    <Text color={slate}>│</Text>
                    <Box marginX={1}>
                        <Text color={glow}>Reasoning: {reasoningEffort}</Text>
                    </Box>
                </>
            )}
        </Box>
    );
};

export default StatusBar;
