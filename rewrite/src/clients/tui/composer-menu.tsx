import React from 'react';
import type { Key } from 'ink';
import { useSlashMenu } from './slash-menu.js';
import { usePathMenu } from './path-menu.js';

const ARGUMENT_COMMANDS = new Set([
  '/effort',
  '/profile',
  '/goal',
  '/mcp-login',
  '/auto-approve',
  '/skills',
  '/rewind',
  '/undo',
]);

/**
 * The composer's pop-up menus behind one contract: `/command` completion and `@path` completion. At most one is
 * open; the session asks `owns(key)` before the editor sees a key and calls `handle` to apply a choice.
 */
export function useComposerMenu(
  value: string,
  enabled: boolean,
  subtleColor: React.ComponentProps<typeof import('ink').Text>['color'],
) {
  const slash = useSlashMenu(value, enabled, subtleColor);
  const path = usePathMenu(value, enabled, subtleColor);
  return {
    owns: (key: Key) => slash.owns(key) || path.owns(key),
    /** Completing a command or path replaces the draft with `text`, cursor after the inserted piece. */
    handle(
      key: Key,
      apply: (text: string, cursor: number) => void,
      openPicker: (command: string) => boolean,
      execute: (command: string) => void,
    ): boolean {
      if (slash.owns(key))
        return slash.handle(key, (command, open) => {
          if (open && openPicker(command)) apply('', 0);
          else if (open && command && !ARGUMENT_COMMANDS.has(command)) {
            apply('', 0);
            execute(command);
          } else apply(command ? `${command} ` : '', command ? command.length + 1 : 0);
        });
      return path.handle(key, apply);
    },
    reset() {
      slash.reset();
      path.reset();
    },
    view: slash.view ?? path.view,
  };
}
