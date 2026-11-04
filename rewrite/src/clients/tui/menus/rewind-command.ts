/**
 * Legacy source/commands/rewind-command.ts for `/rewind`, `/undo` and `/retry`. parseArgs and the
 * action's messages are copied; the action is async here because next reads its rewind targets over the
 * wire, and it returns the turn to rewind instead of rewinding, so the session runs that with its own
 * native rewind once the command's input is settled.
 */
import type { WireRewindTarget } from '../../../protocol/direct-wire.js';
import type { RewindDisposition, RewindItem } from './menu-types.js';

/** The turn a bare invocation acts on, which is what distinguishes the aliases. */
type BareTarget = 'picker' | 'last';

/** Legacy use-app-commands.ts's three rewind commands. */
const COMMANDS: Record<string, { defaultDisposition: RewindDisposition; bareTarget: BareTarget; aliasOf?: string }> = {
  rewind: { defaultDisposition: 'edit', bareTarget: 'picker' },
  undo: { defaultDisposition: 'edit', bareTarget: 'picker', aliasOf: 'rewind' },
  retry: { defaultDisposition: 'resend', bareTarget: 'last', aliasOf: 'rewind' },
};

export const REWIND_COMMAND = /^\/(rewind|undo|retry)(?:\s+([\s\S]*))?$/;

type ParsedArgs =
  | { ok: true; turn: 'picker' | 'last' | number; disposition: RewindDisposition | null }
  | { ok: false; error: string };

const DISPOSITIONS: Record<string, RewindDisposition> = {
  edit: 'edit',
  resend: 'resend',
};

/**
 * Grammar: `[last | <turn number>] [edit | resend]`, in either order. Both parts
 * are optional. An unrecognised token is an error rather than a silent fallback —
 * the previous `/undo 3` and `/retry 3` quietly ignored their argument and acted
 * on a different turn than the user named.
 */
function parseArgs(args: string | undefined): ParsedArgs {
  const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean);

  let turn: 'picker' | 'last' | number | null = null;
  let disposition: RewindDisposition | null = null;

  for (const token of tokens) {
    const lowered = token.toLowerCase();

    const parsedDisposition = DISPOSITIONS[lowered];
    if (parsedDisposition) {
      if (disposition !== null) {
        return { ok: false, error: `Specify only one of edit or resend (got "${args!.trim()}").` };
      }
      disposition = parsedDisposition;
      continue;
    }

    if (lowered === 'last' || /^\d+$/.test(lowered)) {
      if (turn !== null) {
        return { ok: false, error: `Specify only one turn to rewind to (got "${args!.trim()}").` };
      }
      turn = lowered === 'last' ? 'last' : Number(lowered);
      continue;
    }

    return { ok: false, error: `Unrecognised argument "${token}". Usage: [last | <turn number>] [edit | resend]` };
  }

  return { ok: true, turn: turn ?? 'picker', disposition };
}

/** Legacy buildRewindItems, from the Session's targets; next does not track the files a turn touched. */
export function rewindItems(targets: readonly WireRewindTarget[]): RewindItem[] {
  return targets.map((target, index) => ({
    targetId: target.id,
    uiIndex: index,
    turnNumber: index + 1,
    // An image-only turn's label is a placeholder; legacy shows only its "[1 image]" suffix.
    text: target.imageCount > 0 && target.label === '[image input]' ? '' : target.label,
    imageCount: target.imageCount,
    discardedTurns: target.discardedTurns,
    discardedReplies: target.discardedReplies,
    discardedFiles: [],
  }));
}

export async function runRewindCommand(
  input: string,
  deps: {
    readonly listItems: () => Promise<RewindItem[]>;
    readonly addSystemMessage: (text: string) => void;
    readonly openRewindMenu: (items: RewindItem[], disposition: RewindDisposition) => void;
  },
): Promise<{ item: RewindItem; disposition: RewindDisposition } | null> {
  const [, name, args] = REWIND_COMMAND.exec(input.trim())!;
  const { defaultDisposition, bareTarget, aliasOf } = COMMANDS[name!]!;
  const { addSystemMessage } = deps;
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    addSystemMessage(parsed.error);
    return null;
  }

  const disposition = parsed.disposition ?? defaultDisposition;
  const items = await deps.listItems();
  const available = items.length;

  if (available === 0) {
    addSystemMessage('Nothing to rewind.');
    return null;
  }

  if (aliasOf) {
    addSystemMessage(`/${name} is now /${aliasOf} ${disposition} — /${aliasOf} for the full picker.`);
  }

  const target = parsed.turn === 'picker' && bareTarget === 'last' ? 'last' : parsed.turn;

  if (target === 'picker') {
    deps.openRewindMenu(items, disposition);
    return null;
  }

  // Slash-command numbers remain 1-based positions in the *visible*
  // picker list. The displayed store turn number can be offset when the
  // rendered transcript has been capped, so it must not address the
  // domain target directly.
  const selected = target === 'last' ? items.at(-1) : items[target - 1];
  const turnNumber = target === 'last' ? available : target;
  if (!selected) {
    addSystemMessage(`No turn ${turnNumber} to rewind to. Pick a turn between 1-${available}.`);
    return null;
  }
  return { item: selected, disposition };
}
