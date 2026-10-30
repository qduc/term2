const DISPOSITIONS = {
    edit: 'edit',
    resend: 'resend',
};
/**
 * Grammar: `[last | <turn number>] [edit | resend]`, in either order. Both parts
 * are optional. An unrecognised token is an error rather than a silent fallback —
 * the previous `/undo 3` and `/retry 3` quietly ignored their argument and acted
 * on a different turn than the user named.
 */
function parseArgs(args) {
    const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean);
    let turn = null;
    let disposition = null;
    for (const token of tokens) {
        const lowered = token.toLowerCase();
        const parsedDisposition = DISPOSITIONS[lowered];
        if (parsedDisposition) {
            if (disposition !== null) {
                return { ok: false, error: `Specify only one of edit or resend (got "${args.trim()}").` };
            }
            disposition = parsedDisposition;
            continue;
        }
        if (lowered === 'last' || /^\d+$/.test(lowered)) {
            if (turn !== null) {
                return { ok: false, error: `Specify only one turn to rewind to (got "${args.trim()}").` };
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
export function createRewindSlashCommand({ name, defaultDisposition, bareTarget, aliasOf, getRewindItems, rewindToTarget, sendUserMessage, restoreTurnToInput, addSystemMessage, openRewindMenu, onRewind, }) {
    const description = name === 'retry'
        ? 'Resend the last user turn, or choose a turn to resend'
        : name === 'undo'
            ? 'Choose a user turn to remove and return to the input'
            : defaultDisposition === 'resend'
                ? 'Rewind to a user turn and resend it'
                : 'Rewind to a user turn and put it back in the input box';
    return {
        name,
        description: aliasOf && name !== 'retry' ? `${description} (same options as /${aliasOf})` : description,
        expectsArgs: true,
        action: (args) => {
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
            // Slash-command numbers remain 1-based positions in the *visible*
            // picker list. The displayed store turn number can be offset when the
            // rendered transcript has been capped, so it must not address the
            // domain target directly.
            const selected = target === 'last' ? items.at(-1) : items[target - 1];
            const turnNumber = target === 'last' ? available : target;
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
//# sourceMappingURL=rewind-command.js.map