import {useState, useCallback, useMemo} from 'react';
import type {SlashCommand} from '../components/SlashCommandMenu.js';

interface UseSlashCommandsOptions {
	commands: SlashCommand[];
	onClose: () => void;
	setText?: (text: string) => void;
}

export const useSlashCommands = ({
	commands,
	onClose,
	setText,
}: UseSlashCommandsOptions) => {
	const [isOpen, setIsOpen] = useState(false);
	const [filter, setFilter] = useState('');
	const [selectedIndex, setSelectedIndex] = useState(0);

	const filteredCommands = useMemo(
		() =>
			commands.filter(cmd => {
				const lowerFilter = filter.toLowerCase();
				const lowerName = cmd.name.toLowerCase();

				// Case 1: Typing the command (e.g. "mod" matches "model")
				if (!lowerFilter.includes(' ')) {
					return lowerName.includes(lowerFilter);
				}

				// Case 2: Command with arguments (e.g. "model gpt-4" matches "model")
				return lowerFilter.startsWith(lowerName + ' ');
			}),
		[commands, filter],
	);

	const open = useCallback(() => {
		setIsOpen(true);
		setFilter('');
		setSelectedIndex(0);
	}, []);

	const close = useCallback(() => {
		setIsOpen(false);
		setFilter('');
		setSelectedIndex(0);
		onClose();
	}, [onClose]);

	const updateFilter = useCallback((value: string) => {
		// Remove the leading '/' if present
		const filterValue = value.startsWith('/') ? value.slice(1) : value;
		setFilter(filterValue);
		// Reset selection if filter changes
		setSelectedIndex(0);
	}, []);

	const moveUp = useCallback(() => {
		setSelectedIndex(prev =>
			prev > 0 ? prev - 1 : filteredCommands.length - 1,
		);
	}, [filteredCommands.length]);

	const moveDown = useCallback(() => {
		setSelectedIndex(prev =>
			prev < filteredCommands.length - 1 ? prev + 1 : 0,
		);
	}, [filteredCommands.length]);

	const executeSelected = useCallback(() => {
		if (
			filteredCommands.length > 0 &&
			selectedIndex < filteredCommands.length
		) {
			const command = filteredCommands[selectedIndex];

			// Handle autocomplete for commands that expect arguments
			if (command.expectsArgs && setText) {
				const fullCommandPrefix = `${command.name} `;
				// If the current filter doesn't start with the command name + space,
				// it means we haven't fully typed it or added the space yet.
				// We should autocomplete it.
				if (
					!filter
						.toLowerCase()
						.startsWith(fullCommandPrefix.toLowerCase())
				) {
					setText(`/${fullCommandPrefix}`);
					return;
				}
			}

			const args = filter.slice(command.name.length).trim();
			const shouldClose = command?.action(args || undefined);
			if (shouldClose !== false) {
				close();
			}
		}
	}, [filteredCommands, selectedIndex, close, filter, setText]);

	return {
		isOpen,
		filter,
		selectedIndex,
		filteredCommands,
		open,
		close,
		updateFilter,
		moveUp,
		moveDown,
		executeSelected,
	};
};
