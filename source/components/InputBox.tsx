import React, {FC, useEffect, useState, useRef, useCallback} from 'react';
import {Box, Text, useInput} from 'ink';
import { MultilineInput } from 'ink-prompt';
import SlashCommandMenu, {SlashCommand} from './SlashCommandMenu.js';
import PathSelectionMenu from './PathSelectionMenu.js';
import type {PathCompletionItem} from '../hooks/use-path-completion.js';

// Constants
const STOP_CHAR_REGEX = /[\s,;:()[\]{}<>]/;

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
	pathMenuOpen: boolean;
	pathMenuItems: PathCompletionItem[];
	pathMenuSelectedIndex: number;
	pathMenuQuery: string;
	pathMenuLoading: boolean;
	pathMenuError: string | null;
	pathMenuTriggerIndex: number | null;
	onPathMenuOpen: (triggerIndex: number, initialQuery: string) => void;
	onPathMenuClose: () => void;
	onPathMenuFilterChange: (value: string) => void;
	onPathMenuUp: () => void;
	onPathMenuDown: () => void;
	getPathMenuSelection: () => PathCompletionItem | undefined;
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
	pathMenuOpen,
	pathMenuItems,
	pathMenuSelectedIndex,
	pathMenuQuery,
	pathMenuLoading,
	pathMenuError,
	pathMenuTriggerIndex,
	onPathMenuOpen,
	onPathMenuClose,
	onPathMenuFilterChange,
	onPathMenuUp,
	onPathMenuDown,
	getPathMenuSelection,
}) => {
	const [escHintVisible, setEscHintVisible] = useState(false);
	const escTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [cursorOffset, setCursorOffset] = useState(value.length);
	const [cursorOverride, setCursorOverride] = useState<number | null>(null);

	// Cleanup timeout on unmount
	useEffect(() => {
		return () => {
			if (escTimeoutRef.current) {
				clearTimeout(escTimeoutRef.current);
			}
		};
	}, []);

	useEffect(() => {
		if (cursorOverride !== null && cursorOverride === cursorOffset) {
			setCursorOverride(null);
		}
	}, [cursorOverride, cursorOffset]);

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
		{isActive: !slashMenuOpen && !pathMenuOpen},
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
		{isActive: !slashMenuOpen && !pathMenuOpen},
	);

	// Handle input when path menu is open
	useInput(
		(_input, key) => {
			if (!pathMenuOpen) return;

			if (key.upArrow) {
				onPathMenuUp();
			} else if (key.downArrow) {
				onPathMenuDown();
			} else if (key.escape) {
				clearActivePathTrigger();
			} else if (key.tab) {
				insertSelectedPath(false);
			}
		},
		{isActive: pathMenuOpen},
	);

	const [, setInputKey] = useState(0);

	const insertSelectedPath = useCallback(
		(appendTrailingSpace: boolean): boolean => {
			if (!pathMenuOpen || pathMenuTriggerIndex === null) {
				return false;
			}

			const selection = getPathMenuSelection();
			if (!selection) {
				return false;
			}

			const safeCursor = Math.min(cursorOffset, value.length);
			const before = value.slice(0, pathMenuTriggerIndex);
			const after = value.slice(safeCursor);
			const displayPath =
				selection.type === 'directory'
					? `${selection.path}/`
					: selection.path;
			const suffix = appendTrailingSpace ? ' ' : '';
			const nextValue = `${before}${displayPath}${suffix}${after}`;
			onChange(nextValue);
			const nextCursor = before.length + displayPath.length + suffix.length;
			setCursorOverride(nextCursor);
			onPathMenuClose();
			return true;
		},
		[
			pathMenuOpen,
			pathMenuTriggerIndex,
			getPathMenuSelection,
			cursorOffset,
			value,
			onChange,
			onPathMenuClose,
		],
	);

	const clearActivePathTrigger = useCallback(() => {
		if (pathMenuTriggerIndex === null) return;
		const safeCursor = Math.min(cursorOffset, value.length);
		const before = value.slice(0, pathMenuTriggerIndex);
		const after = value.slice(safeCursor);
		onChange(before + after);
		setCursorOverride(pathMenuTriggerIndex);
		onPathMenuClose();
	}, [pathMenuTriggerIndex, cursorOffset, value, onChange, onPathMenuClose]);

	const handleSubmit = useCallback(
		(submittedValue: string) => {
			if (pathMenuOpen) {
				const inserted = insertSelectedPath(true);
				if (inserted) {
					return;
				}
			}
			if (slashMenuOpen) {
				// Execute the selected slash command
				onSlashMenuSelect();
				// Force remount to ensure cursor moves to the end
				setInputKey(prev => prev + 1);
			} else {
				onSubmit(submittedValue);
			}
		},
		[pathMenuOpen, slashMenuOpen, onSlashMenuSelect, onSubmit, insertSelectedPath],
	);

	useEffect(() => {
		if (slashMenuOpen) {
			if (pathMenuOpen) {
				onPathMenuClose();
			}
			return;
		}

		const trigger = findPathTrigger(value, cursorOffset, STOP_CHAR_REGEX);
		if (!trigger) {
			if (pathMenuOpen) {
				onPathMenuClose();
			}
			return;
		}

		if (!pathMenuOpen || pathMenuTriggerIndex !== trigger.start) {
			onPathMenuOpen(trigger.start, trigger.query);
			return;
		}

		if (pathMenuQuery !== trigger.query) {
			onPathMenuFilterChange(trigger.query);
		}
	}, [
		value,
		cursorOffset,
		slashMenuOpen,
		pathMenuOpen,
		pathMenuTriggerIndex,
		pathMenuQuery,
		onPathMenuClose,
		onPathMenuOpen,
		onPathMenuFilterChange,
	]);

	return (
		<Box flexDirection="column">
			{pathMenuOpen && (
				<PathSelectionMenu
					items={pathMenuItems}
					selectedIndex={pathMenuSelectedIndex}
					query={pathMenuQuery}
					loading={pathMenuLoading}
					error={pathMenuError}
				/>
			)}
			{slashMenuOpen && (
				<SlashCommandMenu
					commands={slashCommands}
					selectedIndex={slashMenuSelectedIndex}
					filter={slashMenuFilter}
				/>
			)}
			<Box>
				<Text color="blue">❯ </Text>
				<MultilineInput
					value={value}
					onChange={onChange}
					onSubmit={handleSubmit}
					onCursorChange={setCursorOffset}
					cursorOverride={cursorOverride ?? undefined}
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

const whitespaceRegex = /\s/;

const findPathTrigger = (
	text: string,
	cursor: number,
	stopChars: RegExp,
): {start: number; query: string} | null => {
	if (cursor <= 0 || cursor > text.length) {
		return null;
	}

	for (let index = cursor - 1; index >= 0; index -= 1) {
		const char = text[index];
		if (char === '@') {
			const query = text.slice(index + 1, cursor);
			if (whitespaceRegex.test(query)) {
				return null;
			}
			return {start: index, query};
		}
		if (stopChars.test(char)) {
			break;
		}
	}

	return null;
};
