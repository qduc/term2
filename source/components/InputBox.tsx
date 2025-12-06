import React, {FC, useEffect, useState, useRef, useCallback} from 'react';
import {Box, Text, useInput} from 'ink';
import {MultilineInput} from 'ink-prompt';
import SlashCommandMenu, {SlashCommand} from './SlashCommandMenu.js';
import PathSelectionMenu from './PathSelectionMenu.js';
import type {PathCompletionItem} from '../hooks/use-path-completion.js';

// Constants
const STOP_CHAR_REGEX = /[\s,;:()[\]{}<>]/;
const TERMINAL_PADDING = 3;

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
	const [terminalWidth, setTerminalWidth] = useState(0);

	// Set terminal width on first start and listen for terminal resize events
	useEffect(() => {
		const calculateTerminalWidth = () =>
			Math.max(0, (process.stdout.columns ?? 0) - TERMINAL_PADDING);

		setTerminalWidth(calculateTerminalWidth());

		const handleResize = () => {
			setTerminalWidth(calculateTerminalWidth());
		};

		process.stdout.on('resize', handleResize);
		return () => {
			process.stdout.off('resize', handleResize);
		};
	}, []);

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

	// Handle escape for slash menu (arrow keys now handled via onBoundaryArrow)
	useInput(
		(_input, key) => {
			if (!slashMenuOpen) return;

			if (key.escape) {
				onChange('');
				onSlashMenuClose();
			}
		},
		{isActive: slashMenuOpen},
	);

	// Handle escape and tab for path menu (arrow keys now handled via onBoundaryArrow)
	useInput(
		(_input, key) => {
			if (!pathMenuOpen) return;

			if (key.escape) {
				clearActivePathTrigger();
			} else if (key.tab) {
				insertSelectedPath(false);
			}
		},
		{isActive: pathMenuOpen},
	);

	const [, setInputKey] = useState(0);

	// Handle boundary arrow keys from MultilineInput
	const handleBoundaryArrow = useCallback(
		(direction: 'up' | 'down' | 'left' | 'right') => {
			if (slashMenuOpen) {
				// Slash menu navigation
				if (direction === 'up') {
					onSlashMenuUp();
				} else if (direction === 'down') {
					onSlashMenuDown();
				}
			} else if (pathMenuOpen) {
				// Path menu navigation
				if (direction === 'up') {
					onPathMenuUp();
				} else if (direction === 'down') {
					onPathMenuDown();
				}
			} else {
				// History navigation (when no menu is open)
				if (direction === 'up') {
					onHistoryUp();
					setInputKey(prev => prev + 1);
				} else if (direction === 'down') {
					onHistoryDown();
					setInputKey(prev => prev + 1);
				}
			}
		},
		[
			slashMenuOpen,
			pathMenuOpen,
			onSlashMenuUp,
			onSlashMenuDown,
			onPathMenuUp,
			onPathMenuDown,
			onHistoryUp,
			onHistoryDown,
		],
	);

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
			const nextCursor =
				before.length + displayPath.length + suffix.length;
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
		[
			pathMenuOpen,
			slashMenuOpen,
			onSlashMenuSelect,
			onSubmit,
			insertSelectedPath,
		],
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
					width={terminalWidth}
					onChange={onChange}
					onSubmit={handleSubmit}
					onCursorChange={setCursorOffset}
					cursorOverride={cursorOverride ?? undefined}
					onBoundaryArrow={handleBoundaryArrow}
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
