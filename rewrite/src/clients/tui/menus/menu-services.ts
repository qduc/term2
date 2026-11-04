/**
 * The `services` object legacy ApplicationInputSurface built for the menu
 * sessions, from hooks that stay mounted inside the InputProvider. Each ported
 * menu adds its hook here and its trigger rule id to MENU_RULE_IDS; a rule is
 * enabled only once its session renders, so no frame opens without a view.
 */
import { useMemo } from 'react';
import type { MenuServices } from './menu-registry.js';
import type { SlashCommand } from './slash-command-types.js';
import { useSlashCommands } from './use-slash-commands.js';
import { usePathCompletion } from './use-path-completion.js';
import { useModelSelection } from './use-model-selection.js';
import { useSettingsCompletion } from './use-settings-completion.js';
import { useSettingsValueCompletion } from './use-settings-value-completion.js';
import { useInputContext } from './input-context.js';
import type { CommandResult } from '../integration.js';

/** Session behaviour the menus call back into, replacing legacy app callbacks. */
export type MenuActions = {
  /** Run typed composer text (a slash command or prompt) as if submitted. */
  readonly runCommand: (text: string) => void;
  /** Show a one-line notice, as legacy addSystemMessage did. */
  readonly notice: (text: string) => void;
  /** Run an app-owned command and return its result instead of showing it (menu intents). */
  readonly command: (text: string) => Promise<CommandResult>;
};

/** Legacy ApplicationInputSurface's enabled trigger rule ids, limited to the ported menus. */
export const MENU_RULE_IDS: readonly string[] = [
  'slash',
  'path',
  'command-model',
  'settings-model',
  'settings-subagent-pool-child',
  'settings',
  'settings-value-child',
  'direct-setting-value',
];

export function useMenuServices({
  commands,
}: {
  readonly commands: SlashCommand[];
  readonly actions: MenuActions;
}): MenuServices {
  const slash = useSlashCommands({ commands, onClose: noop });
  const { menus, sessionId } = useInputContext();
  // Legacy passed its one settings service; next's is the attached session's live settings, bound once per
  // session: the model services and the settings reads together make up legacy's SettingsService surface.
  const settingsService = useMemo(
    () => ({ ...menus.models.settings(sessionId), ...menus.settings.service(sessionId) }),
    [menus, sessionId],
  );
  const models = useModelSelection({ settingsService });
  const path = usePathCompletion();
  const settings = useSettingsCompletion(settingsService);
  const settingsValue = useSettingsValueCompletion(settingsService);
  return { slash, path, models, settings, settingsValue, settingsService, schema: menus.schema };
}

const noop = () => {};
