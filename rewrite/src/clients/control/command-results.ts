/** Read native command ownership without granting execution or inventing IDs.
 * A finished command receipt is not a completed model turn or physical cleanup.
 */
import type { WireCommandReceipt, WireNativeCommandOutcome, WireSnapshot } from '../../protocol/direct-wire.js';

type NegativeOutcome = Extract<WireNativeCommandOutcome, { readonly kind: 'rejected' }>;
type FinishedOutcome = Exclude<WireNativeCommandOutcome, { readonly kind: 'rejected' | 'interrupted' }>;
type CommandIdentity = { readonly commandId: string; readonly receipt: WireCommandReceipt };
export type ControlCommandState = CommandIdentity &
  (
    | { readonly state: 'pending' }
    | { readonly state: 'finished'; readonly outcome: FinishedOutcome }
    | { readonly state: 'negative'; readonly outcome: NegativeOutcome }
    | { readonly state: 'unknown'; readonly reason: 'outcome_unobserved' }
  );

/** Preserve the actual per-invocation ID, original request and typed outcome.
 * An interrupted receipt owns possibly effected work; it is not safe to replay.
 */
export function controlCommandState(receipt: WireCommandReceipt): ControlCommandState {
  const identity = { commandId: receipt.request.commandId, receipt };
  const outcome = receipt.outcome;
  if (outcome === undefined) return { ...identity, state: 'pending' };
  if (outcome.kind === 'rejected') return { ...identity, state: 'negative', outcome };
  if (outcome.kind === 'interrupted') return { ...identity, state: 'unknown', reason: outcome.reason };
  return { ...identity, state: 'finished', outcome };
}

/** Null means no command projection was supplied, not that no effect happened.
 * An absent command ID in a snapshot never authorizes another invocation.
 */
export function controlCommands(state: WireSnapshot): readonly ControlCommandState[] | null {
  return state.commands === undefined ? null : state.commands.map(controlCommandState);
}
