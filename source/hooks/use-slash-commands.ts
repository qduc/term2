import {useState, useCallback, useMemo} from 'react';
import type {SlashCommand} from '../components/SlashCommandMenu.js';
import {useInputContext} from '../context/InputContext.js';

interface UseSlashCommandsOptions {
    commands: SlashCommand[];
    onClose: () => void;
    // setText is no longer needed as we use context
}

// Pure functions exported for testing
export function filterCommands(
    commands: SlashCommand[],
    filter: string,
): SlashCommand[] {
    return commands.filter(cmd => {
        const lowerFilter = filter.toLowerCase();
        const lowerName = cmd.name.toLowerCase();

        // Case 1: Typing the command (e.g. "mod" matches "model")
        if (!lowerFilter.includes(' ')) {
            return lowerName.includes(lowerFilter);
        }

        // Case 2: Command with arguments (e.g. "model gpt-4" matches "model")
        return lowerFilter.startsWith(lowerName + ' ');
    });
}

export function shouldAutocomplete(
    command: SlashCommand,
    filter: string,
): boolean {
    if (!command.expectsArgs) {
        return false;
    }

    const fullCommandPrefix = `${command.name} `;
    return !filter.toLowerCase().startsWith(fullCommandPrefix.toLowerCase());
}

export function extractCommandArgs(
    filter: string,
    commandName: string,
): string {
    return filter.slice(commandName.length).trim();
}

export const useSlashCommands = ({
    commands,
    onClose,
}: UseSlashCommandsOptions) => {
    const {mode, setMode, input, setInput} = useInputContext();
    const [selectedIndex, setSelectedIndex] = useState(0);

    const isOpen = mode === 'slash_commands';

    // Derive filter from input directly
    const filter = isOpen
        ? input.startsWith('/')
            ? input.slice(1)
            : input
        : '';

    const filteredCommands = useMemo(
        () => filterCommands(commands, filter),
        [commands, filter],
    );

    const open = useCallback(() => {
        // Avoid resetting selection when already open to preserve
        // keyboard navigation (up/down arrows) state between renders.
        if (mode === 'slash_commands') return;
        setMode('slash_commands');
        setSelectedIndex(0);
    }, [mode, setMode]);

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
            if (shouldAutocomplete(command, filter)) {
                setInput(`/${command.name} `);
                return;
            }

            const args = extractCommandArgs(filter, command.name);
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
