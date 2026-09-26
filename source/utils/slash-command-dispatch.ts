import { parseInput } from './input-parser.js';
import { resolveSlashCommand } from '../slash-commands.js';
import type { SlashCommand } from '../slash-commands.js';

const editDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
};

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
  notify: (message: string) => void = () => undefined,
): boolean {
  // A slash inside a filesystem path is message text, not a command.
  const commandLike = /^\/([A-Za-z0-9][A-Za-z0-9-]*)(?:\s|$)/.exec(text);
  if (!commandLike) return false;

  const parsed = parseInput(text);
  if (parsed.type !== 'slash-command') return false;

  const command = resolveSlashCommand(slashCommands as SlashCommand[], parsed.commandName);
  if (!command) {
    const candidates = slashCommands.filter((candidate) =>
      candidate.name.toLowerCase().startsWith(parsed.commandName.toLowerCase()),
    );
    if (candidates.length > 1) {
      notify(`Ambiguous command /${parsed.commandName}: ${candidates.map(({ name }) => `/${name}`).join(', ')}`);
    } else {
      const nearby = slashCommands
        .map(({ name }) => ({ name, distance: editDistance(parsed.commandName.toLowerCase(), name.toLowerCase()) }))
        .filter(({ distance }) => distance <= Math.max(2, Math.floor(parsed.commandName.length / 3)))
        .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
        .slice(0, 3);
      const suggestions = nearby.length ? `. Did you mean ${nearby.map(({ name }) => `/${name}`).join(', ')}?` : '';
      // Keep the typed text so a typo can be fixed in place.
      notify(`Unknown command /${parsed.commandName}${suggestions}`);
    }
    return true;
  }

  const shouldClearInput = command.action(parsed.args || undefined);
  if (shouldClearInput !== false) {
    replaceInput('');
  }
  return true;
}
