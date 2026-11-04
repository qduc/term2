import React from 'react';
import type { Key } from 'ink';
import { usePathMenu } from './path-menu.js';

/**
 * The composer's native `@path` completion. The session asks `owns(key)` before the editor sees a key and calls
 * `handle` to apply a choice. Slash commands are the ported legacy menu stack (`menus/`).
 */
export function useComposerMenu(
  value: string,
  enabled: boolean,
  subtleColor: React.ComponentProps<typeof import('ink').Text>['color'],
) {
  const path = usePathMenu(value, enabled, subtleColor);
  return {
    owns: (key: Key) => path.owns(key),
    /** Completing a path replaces the draft with `text`, cursor after the inserted piece. */
    handle(key: Key, apply: (text: string, cursor: number) => void): boolean {
      return path.handle(key, apply);
    },
    reset() {
      path.reset();
    },
    view: path.view,
  };
}
