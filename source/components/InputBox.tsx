import React, {FC, useEffect, useState, useRef} from 'react';
import {Box, Text, useInput} from 'ink';
import TextInput from './TextInput.js';
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
	onHistoryUp: () => void;
	onHistoryDown: () => void;
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
	onHistoryUp,
	onHistoryDown,
}) => {
	const [escHintVisible, setEscHintVisible] = useState(false);
	const escTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Cleanup timeout on unmount
	useEffect(() => {
		return () => {
			if (escTimeoutRef.current) {
				clearTimeout(escTimeoutRef.current);
			}
		};
	}, []);

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

	// Handle escape key for clearing input (double-press)
	useInput(
		(_input, key) => {
			if (key.escape) {
				if (escHintVisible) {
					// Second press - clear the input
					if (escTimeoutRef.current) {
						clearTimeout(escTimeoutRef.current);
						escTimeoutRef.current = null;
					}
					setEscHintVisible(false);
					onChange('');
				} else {
					// First press - show hint and start timer
					setEscHintVisible(true);
					escTimeoutRef.current = setTimeout(() => {
						setEscHintVisible(false);
						escTimeoutRef.current = null;
					}, 2000);
				}
			}
		},
		{isActive: !slashMenuOpen},
	);

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

	// Handle arrow keys for input history when slash menu is closed
	useInput(
		(_input, key) => {
			if (key.upArrow) {
				onHistoryUp();
				setInputKey(prev => prev + 1);
			} else if (key.downArrow) {
				onHistoryDown();
				setInputKey(prev => prev + 1);
			}
		},
		{isActive: !slashMenuOpen},
	);

	const [inputKey, setInputKey] = useState(0);

	const handleSubmit = (submittedValue: string) => {
		if (slashMenuOpen) {
			// Execute the selected slash command
			onSlashMenuSelect();
			// Force remount to ensure cursor moves to the end
			setInputKey(prev => prev + 1);
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
				<TextInput
					key={inputKey}
					value={value}
					onChange={onChange}
					onSubmit={handleSubmit}
				/>
			</Box>
			{escHintVisible && (
				<Text color="gray" dimColor>
					Press ESC again to clear input
				</Text>
			)}
		</Box>
	);
};

export default InputBox;
