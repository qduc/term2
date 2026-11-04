/**
 * The `services` object legacy ApplicationInputSurface built for the menu
 * sessions, from hooks that stay mounted inside the InputProvider. Each ported
 * menu adds its hook here and its trigger rule id to MENU_RULE_IDS; a rule is
 * enabled only once its session renders, so no frame opens without a view.
 */
import type { MenuServices } from './menu-registry.js';
import type { SlashCommand } from './slash-command-types.js';
import { useSlashCommands } from './use-slash-commands.js';

/** Session behaviour the menus call back into, replacing legacy app callbacks. */
export type MenuActions = {
  /** Run typed composer text (a slash command or prompt) as if submitted. */
  readonly runCommand: (text: string) => void;
  /** Show a one-line notice, as legacy addSystemMessage did. */
  readonly notice: (text: string) => void;
};

/** Legacy ApplicationInputSurface's enabled trigger rule ids, limited to the ported menus. */
export const MENU_RULE_IDS: readonly string[] = ['slash'];

export function useMenuServices({
  commands,
}: {
  readonly commands: SlashCommand[];
  readonly actions: MenuActions;
}): MenuServices {
  const slash = useSlashCommands({ commands, onClose: noop });
  return { slash };
}

const noop = () => {};
