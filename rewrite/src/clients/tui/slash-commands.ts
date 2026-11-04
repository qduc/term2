import { LEGACY_COMMANDS } from './menus/legacy-commands.js';

/**
 * Legacy's `/help` text (source/hooks/use-app-commands.ts): every listed command except `/undo`, then the
 * keyboard shortcuts. The list is legacy-commands.ts, the slash menu's own table, so commands dropped by owner
 * scope are absent from both, and commands the old CLI lacks are not advertised.
 */
export function helpText(): string {
  const commandLines = LEGACY_COMMANDS.filter(({ name }) => name !== 'undo')
    .map(({ name, description }) => `/${name} — ${description}`)
    .join('\n');
  return `Commands\n${commandLines}\n\nKeyboard shortcuts\nCtrl+C: clear draft or interrupt; press again to exit\nCtrl+O: choose model · Ctrl+T: choose reasoning effort\nShift+Tab: switch Standard/Plan · @: complete paths · !: shell`;
}
