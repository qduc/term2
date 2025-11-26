import React, {FC} from 'react';
import {Box, Text} from 'ink';

export interface SlashCommand {
	name: string;
	description: string;
	action: (args?: string) => boolean | void;
	expectsArgs?: boolean;
}

type Props = {
	commands: SlashCommand[];
	selectedIndex: number;
	filter: string;
};

const SlashCommandMenu: FC<Props> = ({commands, selectedIndex, filter}) => {
	const filteredCommands = commands.filter(cmd =>
		cmd.name.toLowerCase().includes(filter.toLowerCase()),
	);

	if (filteredCommands.length === 0) {
		return (
			<Box flexDirection="column" marginLeft={2}>
				<Text color="gray" dimColor>
					No matching commands
				</Text>
			</Box>
		);
	}

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="blue"
			paddingX={1}
		>
			{filteredCommands.map((cmd, index) => (
				<Box key={cmd.name}>
					<Text
						color={index === selectedIndex ? 'blue' : undefined}
						bold={index === selectedIndex}
						inverse={index === selectedIndex}
					>
						{' '}
						/{cmd.name}{' '}
					</Text>
					<Text color="gray"> - {cmd.description}</Text>
				</Box>
			))}
		</Box>
	);
};

export default SlashCommandMenu;
