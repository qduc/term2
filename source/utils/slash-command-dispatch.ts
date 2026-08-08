import { parseInput } from './input-parser.js';
import { resolveSlashCommand } from '../slash-commands.js';
import type { SlashCommand } from '../slash-commands.js';

/**
 * The one place that decides whether a fully-formed piece of text is a slash
 * command to execute locally versus ordinary content. Both the primary
 * submit path (`app.tsx`'s `handleSubmit`, reached when the user types text
 * and presses Enter with no menu open) and the menu-controller's
 * `submit-prompt` intent host (reached when a controller-owned menu, e.g.
 * the direct `/model ` picker, finishes by handing off already-composed
 * command text) call this so the two paths cannot drift: text like
 * `/model gpt-4` always resolves to executing the `/model` command's
 * `action`, never to being sent to the model as a literal chat message,
 * regardless of which caller produced it.
 *
 * Returns `true` when `text` resolved to a known slash command and its
 * `action` was invoked (input is cleared unless the action explicitly
 * returns `false`). Returns `false` when `text` is not a slash command, or
 * names one that isn't registered — the caller is expected to fall back to
 * sending `text` as ordinary content in that case.
 */
export function tryExecuteSlashCommand(
  text: string,
  slashCommands: readonly SlashCommand[],
  replaceInput: (value: string) => void,
): boolean {
  const parsed = parseInput(text);
  if (parsed.type !== 'slash-command') return false;

  const command = resolveSlashCommand(slashCommands as SlashCommand[], parsed.commandName);
  if (!command) return false;

  const shouldClearInput = command.action(parsed.args || undefined);
  if (shouldClearInput !== false) {
    replaceInput('');
  }
  return true;
}
