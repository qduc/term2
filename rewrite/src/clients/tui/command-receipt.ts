import type { WireContent } from '../../protocol/direct-wire.js';
import type { TuiConnection } from './integration.js';
import { commandStatus, receiptNotice } from './commands.js';
import { primaryDraft } from './draft.js';

/**
 * `/command-status <id>` and `/command-apply <id>`: report a native command's receipt, or apply its outcome.
 * `restored` means the composer now holds a rewind draft, which the caller must leave in place.
 */
export async function runCommandReceipt(
  connection: TuiConnection,
  input: string,
  apply: {
    readonly restoreDraft: (draft: { readonly text: string; readonly attachments: readonly WireContent[] }) => void;
    readonly switchSession: ((sessionId: string) => Promise<void>) | undefined;
  },
): Promise<{ readonly notice: string | null; readonly restored?: true }> {
  const match = /^\/command-(status|apply)\s+(\S+)$/.exec(input.trim());
  if (!match) throw new Error('Use /command-status <id> or /command-apply <id>.');
  const result = await commandStatus(connection, match[2]);
  if (match[1] === 'status' || result.kind !== 'finished') return { notice: receiptNotice(result) };
  const outcome = result.receipt.outcome;
  if (outcome?.kind === 'rewound') {
    apply.restoreDraft(primaryDraft(outcome.draft.content));
    return { notice: 'Rewind draft restored. Review before sending.', restored: true };
  }
  if (outcome?.kind !== 'rolled_over') return { notice: receiptNotice(result) };
  if (!apply.switchSession) throw new Error(`Session ${outcome.sessionId} needs an app session switch.`);
  await apply.switchSession(outcome.sessionId);
  return { notice: null };
}
