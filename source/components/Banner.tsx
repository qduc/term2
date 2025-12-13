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
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={accent}
			paddingX={2}
			paddingY={1}
		>
			{/* Header */}
			<Box justifyContent="space-between" alignItems="center">
				<Box alignItems="center">
					<Text color={glow} bold>
						{'▌'}
					</Text>
					<Text color={accent} bold>
						{' '}TUI Code Pilot
					</Text>
					<Text color={slate}>{'  •  fast, focused, keyboard-first'}</Text>
				</Box>

				{/* Mode pill */}
				<Box>
					<Text
						backgroundColor={mode === 'edit' ? '#1d4ed8' : '#0f766e'}
						color="white"
						bold
					>
						{' '}
						{mode === 'edit' ? 'EDIT MODE' : 'DEFAULT'}
						{' '}
					</Text>
				</Box>
			</Box>

			{/* Status line */}
			<Box justifyContent="space-between" marginTop={1} flexWrap="wrap">
				<Box flexDirection="column" marginRight={3}>
					<Text color={slate}>
						Provider:{' '}
						<Text color="white" bold>
							{providerLabel}
						</Text>
					</Text>
					<Text color={slate}>
						Model:{' '}
						<Text color="white" bold>
							{model ? (model.length > 34 ? `${model.slice(0, 31)}…` : model) : '—'}
						</Text>
					</Text>
				</Box>

				<Box flexDirection="column">
					<Text color={slate}>
						Reasoning:{' '}
						<Text color="white" bold>
							{reasoningEffort}
						</Text>
					</Text>
					<Text color={slate}>
						Hint:{' '}
						<Text color={accent} bold>
							Tab
						</Text>
						<Text color={slate}>
							{' '}
							complete •{' '}
						</Text>
						<Text color={accent} bold>
							Enter
						</Text>
						<Text color={slate}>
							{' '}
							run •{' '}
						</Text>
						<Text color={accent} bold>
							Esc
						</Text>
						<Text color={slate}>
							{' '}
							back
						</Text>
					</Text>
				</Box>
			</Box>

			{/* Footer sparkle */}
			<Box>
				<Text color={glow} bold>
					{'✦ '}
				</Text>
				<Text color={slate}>
					Code with purpose. Ship with confidence.
				</Text>
			</Box>
		</Box>
	);
};

export default Banner;
