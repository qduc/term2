import React, {FC} from 'react';
import {Box, Text} from 'ink';
import { useSetting } from '../hooks/use-setting.js';

const Banner: FC = () => {
    const mode = useSetting<'default' | 'edit'>('app.mode') ?? 'default';
    const model = useSetting<string>('agent.model');
    const provider = useSetting<string>('agent.provider') ?? 'openai';
    const reasoningEffort = useSetting<string>('agent.reasoningEffort') ?? 'default';

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
							{' '}({provider === 'openrouter' ? 'OpenRouter' : provider === 'openai' ? 'OpenAI' : provider})
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
