import {useState, useCallback, useMemo} from 'react';
import type {SlashCommand} from '../components/SlashCommandMenu.js';
import { useInputContext } from '../context/InputContext.js';

interface UseSlashCommandsOptions {
    commands: SlashCommand[];
    onClose: () => void;
    // setText is no longer needed as we use context
}

export const useSlashCommands = ({
    commands,
    onClose,
}: UseSlashCommandsOptions) => {
    const { mode, setMode, input, setInput } = useInputContext();
    const [selectedIndex, setSelectedIndex] = useState(0);

    const isOpen = mode === 'slash_commands';

    // Derive filter from input directly
    const filter = isOpen ? (input.startsWith('/') ? input.slice(1) : input) : '';

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
        setMode('slash_commands');
        setSelectedIndex(0);
    }, [setMode]);

    const close = useCallback(() => {
        if (mode === 'slash_commands') {
            setMode('text');
            onClose();
        }
    }, [mode, setMode, onClose]);

    // No need for updateFilter anymore, it reacts to input changes automatically

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
            if (command.expectsArgs) {
                const fullCommandPrefix = `${command.name} `;
                // If the current filter doesn't start with the command name,
                // it means we haven't fully typed it or added the space yet.
                // We should autocomplete it.
                if (
                    !filter
                        .toLowerCase()
                        .startsWith(fullCommandPrefix.toLowerCase())
                ) {
                    setInput(`/${fullCommandPrefix}`);
                    return;
                }
            }

            const args = filter.slice(command.name.length).trim();
            const shouldClose = command?.action(args || undefined);
            if (shouldClose !== false) {
                close();
            }
        }
    }, [filteredCommands, selectedIndex, close, filter, setInput]);

    return {
        isOpen,
        filter,
        selectedIndex,
        filteredCommands,
        open,
        close,
        // updateFilter removed
        moveUp,
        moveDown,
        executeSelected,
    };
};
