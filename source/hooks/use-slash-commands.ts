import { useCallback, useEffect, useMemo, useState } from 'react';
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
  setCursorOverride: (offset: number | null) => void;
  close: () => void;
};

// Pure functions exported for testing
export function filterCommands(commands: SlashCommand[], filter: string): SlashCommand[] {
  const lowerFilter = filter.toLowerCase();

  if (!lowerFilter) {
    return commands;
  }

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
  setCursorOverride,
  close,
}: ExecuteSlashCommandSelectionArgs): void {
  if (!command) return;

  if (shouldAutocomplete(command, filter)) {
    const nextValue = `/${command.name} `;
    setInput(nextValue);
    setCursorOverride(nextValue.length);
    // Close slash menu first so mode-changing actions (e.g. /undo opening
    // undo_selection) can take effect; later setMode calls win.
    close();
    const shouldClose = command.action();
    if (shouldClose !== false) {
      setInput('');
      setCursorOverride(null);
    }
    return;
  }

  const args = extractCommandArgs(filter, command.name);
  // Close slash menu first. Mode-changing actions (e.g. /undo opening undo_selection)
  // can then take effect; later setMode calls win, and we avoid post-action override.
  close();
  const shouldClose = command.action(args || undefined);
  if (shouldClose !== false) {
    setInput('');
    setCursorOverride(null);
  }
}

export const useSlashCommands = ({ commands, onClose }: UseSlashCommandsOptions) => {
  const { mode, setMode, input, setInput, setInputAndCursor, setCursorOverride } = useInputContext();

  const isOpen = mode === 'slash_commands';

  // Derive filter from input directly
  const filter = isOpen ? (input.startsWith('/') ? input.slice(1) : input) : '';

  const filteredCommands = useMemo(() => filterCommands(commands, filter), [commands, filter]);

  const MAX_VISIBLE_ITEMS = 10;
  const [scrollOffset, setScrollOffset] = useState(0);

  const { selectedIndex, setSelectedIndex, moveUp, moveDown, moveHome, moveEnd, pageUp, pageDown, getSelectedItem } =
    useSelection(filteredCommands);

  // Sync scrollOffset with selectedIndex
  useEffect(() => {
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + MAX_VISIBLE_ITEMS) {
      setScrollOffset(selectedIndex - MAX_VISIBLE_ITEMS + 1);
    }
  }, [selectedIndex, scrollOffset]);

  // Reset scroll when menu opens or closes
  useEffect(() => {
    setScrollOffset(0);
  }, [isOpen]);

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
      setCursorOverride,
      close,
    });
  }, [getSelectedItem, close, filter, setInput, setCursorOverride]);

  const completeSelected = useCallback(() => {
    const command = getSelectedItem();
    if (command) {
      const nextValue = `/${command.name} `;
      setInputAndCursor(nextValue, nextValue.length, nextValue.length);
    }
  }, [getSelectedItem, setInputAndCursor]);

  return {
    isOpen,
    filter,
    selectedIndex,
    scrollOffset,
    filteredCommands,
    open,
    close,
    // updateFilter removed
    moveUp,
    moveDown,
    moveHome,
    moveEnd,
    pageUp,
    pageDown,
    getSelectedItem,
    executeSelected,
    completeSelected,
  };
};
