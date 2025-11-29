import React, {FC} from 'react';
import {Box, Text} from 'ink';

type Props = {
	text?: string;
	reasoningText?: string;
};

/**
 * LiveResponse displays streaming text as plain text to avoid
 * issues with Markdown parsing of incomplete/partial content.
 * The final response will be rendered with full Markdown formatting.
 * Reasoning text is displayed in light gray before the main response.
 */
const LiveResponse: FC<Props> = ({text, reasoningText}) => {
	return (
		<Box marginBottom={1} flexDirection="column">
			{reasoningText && (
				<Text color="gray" dimColor>
					{reasoningText}
				</Text>
			)}
			<Text>{text || (reasoningText ? '' : ' ')}</Text>
		</Box>
	);
};

export default LiveResponse;
