/**
 * Legacy's typed slash command resolution (source/utils/slash-command-dispatch.ts and
 * source/slash-commands.ts `resolveSlashCommand`), over legacy-commands.ts: an exact name in any case, else
 * a unique prefix, runs that command; several prefix matches are "Ambiguous"; none is "Unknown", with
 * legacy's nearby-name suggestions. Text whose first word is not command-like (`/tmp/x`) is a message.
 */
import { LEGACY_COMMANDS } from './menus/legacy-commands.js';

/** Typed commands this client still runs by their exact name although legacy's table does not list them. */
const OTHER_COMMANDS = new Set(['plan', 'mentor', 'orchestrator', 'sandbox', 'mcp', 'mcp-login']);

export type TypedCommand =
  | { readonly kind: 'message' }
  | { readonly kind: 'command'; readonly input: string }
  | { readonly kind: 'refused'; readonly notice: string };

const editDistance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0]!;
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column]!;
      previous[column] = Math.min(
        previous[column]! + 1,
        previous[column - 1]! + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length]!;
};

/** Legacy's ". Did you mean …?" tail: up to three names within its edit-distance bound. */
function suggestions(typed: string): string {
  const nearby = LEGACY_COMMANDS.map(({ name }) => ({ name, distance: editDistance(typed, name.toLowerCase()) }))
    .filter(({ distance }) => distance <= Math.max(2, Math.floor(typed.length / 3)))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, 3);
  return nearby.length ? `. Did you mean ${nearby.map(({ name }) => `/${name}`).join(', ')}?` : '';
}

export function resolveTypedCommand(input: string): TypedCommand {
  const commandLike = /^\/([A-Za-z0-9][A-Za-z0-9-]*)(?:\s|$)/.exec(input);
  if (!commandLike) return { kind: 'message' };
  const name = commandLike[1]!;
  const rest = input.slice(1 + name.length);
  const lower = name.toLowerCase();
  const exact = LEGACY_COMMANDS.find((command) => command.name.toLowerCase() === lower);
  const candidates = exact ? [exact] : LEGACY_COMMANDS.filter((command) => command.name.startsWith(lower));
  if (candidates.length === 1) {
    const entry = candidates[0]!;
    return { kind: 'command', input: `/${entry.runs ?? entry.name}${rest}` };
  }
  if (OTHER_COMMANDS.has(name)) return { kind: 'command', input };
  if (candidates.length > 1)
    return {
      kind: 'refused',
      notice: `Ambiguous command /${name}: ${candidates.map((command) => `/${command.name}`).join(', ')}`,
    };
  return { kind: 'refused', notice: `Unknown command /${name}${suggestions(lower)}` };
}
