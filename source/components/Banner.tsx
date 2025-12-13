import React, {FC} from 'react';
import {Box, Text} from 'ink';
import { useSetting } from '../hooks/use-setting.js';
import {getProvider} from '../providers/index.js';
import type {SettingsService} from '../services/settings-service.js';

interface BannerProps {
    settingsService: SettingsService;
}

const Banner: FC<BannerProps> = ({settingsService}) => {
    const mode = useSetting<'default' | 'edit'>(settingsService, 'app.mode') ?? 'default';
    const model = useSetting<string>(settingsService, 'agent.model');
    const providerKey = useSetting<string>(settingsService, 'agent.provider') ?? 'openai';
    const reasoningEffort = useSetting<string>(settingsService, 'agent.reasoningEffort') ?? 'default';

    const providerDef = getProvider(providerKey);
    const providerLabel = providerDef?.label || providerKey;

    const accent = '#0ed7b5';
    const glow = '#fbbf24';
    const slate = '#64748b'; // Slate 500 for better visibility than 400

    return (
        <Box marginBottom={1}>
            <Box marginRight={1}>
                <Text color={accent} bold>term</Text>
                <Text color={glow} bold>²</Text>
            </Box>

            <Text color={slate}>│</Text>

            <Box marginX={1}>
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
						<Text color={slate}>
							{' '}({providerLabel})
						</Text>
                    </Box>
                </>
            )}

            {reasoningEffort && reasoningEffort !== 'default' && (
                <>
                    <Text color={slate}>│</Text>
                    <Box marginX={1}>
                        <Text color={glow}>
                            {reasoningEffort === 'none' ? 'Reasoning: none' :
                             reasoningEffort === 'minimal' ? 'Reasoning: minimal' :
                             reasoningEffort === 'low' ? 'Reasoning: low' :
                             reasoningEffort === 'medium' ? 'Reasoning: medium' :
                             reasoningEffort === 'high' ? 'Reasoning: high' : 'Reasoning: default'}
                        </Text>
                    </Box>
                </>
            )}
        </Box>
    );
};

export default Banner;
