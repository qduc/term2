import React, {FC} from 'react';
import {Box, Text} from 'ink';

type Props = {
	command: string;
	output?: string;
	success?: boolean | null;
};

const CommandMessage: FC<Props> = ({command, output, success}) => {
	const outputText = output?.trim() ? output : '(no output)';
	const displayed =
		outputText && outputText !== '(no output)'
			? (() => {
					const lines = (output || '').split('\n');
					return lines.length > 3
						? lines.slice(0, 3).join('\n') + '\n...'
						: output;
			  })()
			: outputText;

	return (
		<Box flexDirection="column">
			<Text color={success === false ? 'red' : 'cyan'}>
				$ <Text bold>{command}</Text>
			</Text>
			<Text color={success === false ? 'red' : 'white'}>{displayed}</Text>
		</Box>
	);
};

export default CommandMessage;
