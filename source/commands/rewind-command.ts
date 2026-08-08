import type { SlashCommand } from '../slash-commands.js';
import type { UserTurn } from '../types/user-turn.js';
import type { RewindItem } from '../utils/conversation/rewind-items.js';

/** What to do with a rewound turn's content once it leaves the transcript. */
export type RewindDisposition = 'edit' | 'resend';

/** The turn a bare invocation acts on, which is what distinguishes the aliases. */
export type BareTarget = 'picker' | 'last';

type RewoundTurn = { text: string; images?: UserTurn['images'] };

interface CreateRewindSlashCommandOptions {
  /** Command name as typed, e.g. `rewind`, `undo`, `retry`. */
  name: string;
  /** Disposition used when the invocation does not name one. */
  defaultDisposition: RewindDisposition;
  /** Whether a bare invocation opens the picker or acts on the last turn. */
  bareTarget: BareTarget;
  /** Set on alias commands so the canonical spelling can be surfaced once. */
  aliasOf?: string;
  /** Current UI projection of authoritative target ids, used only to select an id. */
  getRewindItems: () => readonly RewindItem[];
  rewindToTarget: (item: RewindItem) => RewoundTurn | null;
  sendUserMessage: (input: string | UserTurn) => Promise<void>;
  restoreTurnToInput: (turn: RewoundTurn) => void;
  addSystemMessage: (text: string) => void;
  openRewindMenu: (disposition: RewindDisposition) => void;
  onRewind?: () => void;
}

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

/**
 * Builds one of the rewind commands. `/rewind` is canonical; `/undo` and
 * `/retry` are the same machinery with different defaults, which is what keeps
 * their reset semantics, image handling, and turn numbering identical.
 */
export function createRewindSlashCommand({
  name,
  defaultDisposition,
  bareTarget,
  aliasOf,
  getRewindItems,
  rewindToTarget,
  sendUserMessage,
  restoreTurnToInput,
  addSystemMessage,
  openRewindMenu,
  onRewind,
}: CreateRewindSlashCommandOptions): SlashCommand {
  const description =
    defaultDisposition === 'resend'
      ? 'Rewind to a user turn and resend it'
      : 'Rewind to a user turn and put it back in the input box';

  return {
    name,
    description: aliasOf ? `${description} (alias of /${aliasOf})` : description,
    expectsArgs: true,
    action: (args?: string) => {
      const parsed = parseArgs(args);
      if (!parsed.ok) {
        addSystemMessage(parsed.error);
        return true;
      }

      const disposition = parsed.disposition ?? defaultDisposition;
      const items = getRewindItems();
      const available = items.length;

      if (available === 0) {
        addSystemMessage('Nothing to rewind.');
        return true;
      }

      if (aliasOf) {
        addSystemMessage(`/${name} is now /${aliasOf} ${disposition} — /${aliasOf} for the full picker.`);
      }

      const target = parsed.turn === 'picker' && bareTarget === 'last' ? 'last' : parsed.turn;

      if (target === 'picker') {
        openRewindMenu(disposition);
        return true;
      }

      const selected = target === 'last' ? items.at(-1) : items.find((item) => item.turnNumber === target);
      const turnNumber = target === 'last' ? items.at(-1)?.turnNumber ?? available : target;
      if (!selected) {
        addSystemMessage(`No turn ${turnNumber} to rewind to. Pick a turn between 1-${available}.`);
        return true;
      }

      const rewound = rewindToTarget(selected);
      if (!rewound) {
        addSystemMessage('Nothing to rewind.');
        return true;
      }

      onRewind?.();

      if (disposition === 'resend') {
        void sendUserMessage({ text: rewound.text, ...(rewound.images?.length ? { images: rewound.images } : {}) });
        return true;
      }

      restoreTurnToInput(rewound);
      // Returning false keeps the restored text in the input box instead of
      // letting the slash-command handler clear it.
      return false;
    },
  };
}
