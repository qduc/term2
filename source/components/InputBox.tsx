import React, {FC, useEffect} from 'react';
import {Box, Text, useInput} from 'ink';
import TextInput from 'ink-text-input';
import SlashCommandMenu, {SlashCommand} from './SlashCommandMenu.js';

type Props = {
	value: string;
	onChange: (v: string) => void;
	onSubmit: (v: string) => void;
	slashCommands: SlashCommand[];
	slashMenuOpen: boolean;
	slashMenuSelectedIndex: number;
	slashMenuFilter: string;
	onSlashMenuOpen: () => void;
	onSlashMenuClose: () => void;
	onSlashMenuUp: () => void;
	onSlashMenuDown: () => void;
	onSlashMenuSelect: () => void;
	onSlashMenuFilterChange: (filter: string) => void;
};

const InputBox: FC<Props> = ({
	value,
	onChange,
	onSubmit,
	slashCommands,
	slashMenuOpen,
	slashMenuSelectedIndex,
	slashMenuFilter,
	onSlashMenuOpen,
	onSlashMenuClose,
	onSlashMenuUp,
	onSlashMenuDown,
	onSlashMenuSelect,
	onSlashMenuFilterChange,
}) => {
	// Detect when user types '/' at the start
	useEffect(() => {
		if (value === '/' && !slashMenuOpen) {
			onSlashMenuOpen();
		} else if (value.startsWith('/') && slashMenuOpen) {
			onSlashMenuFilterChange(value);
		} else if (!value.startsWith('/') && slashMenuOpen) {
			onSlashMenuClose();
		}
	}, [
		value,
		slashMenuOpen,
		onSlashMenuOpen,
		onSlashMenuClose,
		onSlashMenuFilterChange,
	]);

	// Handle arrow keys and escape for slash menu
	useInput(
		(_input, key) => {
			if (!slashMenuOpen) return;

			if (key.upArrow) {
				onSlashMenuUp();
			} else if (key.downArrow) {
				onSlashMenuDown();
			} else if (key.escape) {
				onChange('');
				onSlashMenuClose();
			}
		},
		{isActive: slashMenuOpen},
	);

	const handleSubmit = (submittedValue: string) => {
		if (slashMenuOpen) {
			// Execute the selected slash command
			onSlashMenuSelect();
		} else {
			onSubmit(submittedValue);
		}
	};

	return (
		<Box flexDirection="column">
			{slashMenuOpen && (
				<SlashCommandMenu
					commands={slashCommands}
					selectedIndex={slashMenuSelectedIndex}
					filter={slashMenuFilter}
				/>
			)}
			<Box>
				<Text color="blue">❯ </Text>
				<TextInput value={value} onChange={onChange} onSubmit={handleSubmit} />
			</Box>
		</Box>
	);
};

export default InputBox;
