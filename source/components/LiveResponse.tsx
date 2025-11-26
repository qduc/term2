import React, {FC} from 'react';
import {Box, Text} from 'ink';

type Props = {
	text?: string;
};

/**
 * LiveResponse displays streaming text as plain text to avoid
 * issues with Markdown parsing of incomplete/partial content.
 * The final response will be rendered with full Markdown formatting.
 */
const LiveResponse: FC<Props> = ({text}) => {
	return (
		<Box marginBottom={1} flexDirection="column">
			<Text>{text || ' '}</Text>
		</Box>
	);
};

export default LiveResponse;
