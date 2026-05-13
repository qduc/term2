import { useCallback, useMemo } from 'react';
import type { SlashCommand } from '../slash-commands.js';
import { useInputContext } from '../context/InputContext.js';
import { useSelection } from './use-selection.js';

interface UseSlashCommandsOptions {
  commands: SlashCommand[];
  onClose: () => void;
  // setText is no longer needed as we use context
}

type ExecuteSlashCommandSelectionArgs = {
  command: SlashCommand | undefined;
  filter: string;
  setInput: (value: string) => void;
  close: () => void;
};

// Pure functions exported for testing
export function filterCommands(commands: SlashCommand[], filter: string): SlashCommand[] {
  const lowerFilter = filter.toLowerCase();

  return commands
    .filter((cmd) => {
      const lowerName = cmd.name.toLowerCase();

      // Case 1: Typing the command (e.g. "mod" matches "model")
      if (!lowerFilter.includes(' ')) {
        return lowerName.includes(lowerFilter);
      }

      // Case 2: Command with arguments (e.g. "model gpt-4" matches "model")
      return lowerFilter.startsWith(lowerName + ' ');
    })
    .sort((a, b) => {
      const aLower = a.name.toLowerCase();
      const bLower = b.name.toLowerCase();

      const aStartsWith = aLower.startsWith(lowerFilter);
      const bStartsWith = bLower.startsWith(lowerFilter);

      if (aStartsWith && !bStartsWith) return -1;
      if (!aStartsWith && bStartsWith) return 1;

      // Maintain alphabetical order for items within the same priority
      return aLower.localeCompare(bLower);
    });
}

export function shouldAutocomplete(command: SlashCommand, filter: string): boolean {
  if (!command.expectsArgs) {
    return false;
  }

  const fullCommandPrefix = `${command.name} `;
  return !filter.toLowerCase().startsWith(fullCommandPrefix.toLowerCase());
}

export function extractCommandArgs(filter: string, commandName: string): string {
  return filter.slice(commandName.length).trim();
}

export function executeSlashCommandSelection({
  command,
  filter,
  setInput,
  close,
}: ExecuteSlashCommandSelectionArgs): void {
  if (!command) return;

  if (shouldAutocomplete(command, filter)) {
    setInput(`/${command.name} `);
    return;
  }

  const args = extractCommandArgs(filter, command.name);
  const shouldClose = command.action(args || undefined);
  if (shouldClose !== false) {
    setInput('');
    close();
  }
}

export const useSlashCommands = ({ commands, onClose }: UseSlashCommandsOptions) => {
  const { mode, setMode, input, setInput } = useInputContext();

  const isOpen = mode === 'slash_commands';

  // Derive filter from input directly
  const filter = isOpen ? (input.startsWith('/') ? input.slice(1) : input) : '';

  const filteredCommands = useMemo(() => filterCommands(commands, filter), [commands, filter]);

  const { selectedIndex, setSelectedIndex, moveUp, moveDown, getSelectedItem } = useSelection(filteredCommands);

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

  const executeSelected = useCallback(() => {
    executeSlashCommandSelection({
      command: getSelectedItem(),
      filter,
      setInput,
      close,
    });
  }, [getSelectedItem, close, filter, setInput]);

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
    getSelectedItem,
    executeSelected,
  };
};
