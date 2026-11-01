/** Public command receipts from the sole native Session writer; no execution,
 * command cache, request fingerprint or recovery policy belongs in this adapter.
 */
import type { DirectCommandFact, DirectCommandReceipt, DirectCommandRequest, DirectCommandResult } from '../session/direct-command-types.js';
import type { DirectSession } from '../session/facade-types.js';
import type { ExecutionId } from '../tools/index.js';
import type { WireCommand, WireCommandReceipt, WireCommandResult, WireEvent, WireSnapshot } from './direct-wire.js';

type KeyedCommand = Extract<WireCommand, { readonly type: 'retry' | 'compact' | 'rewind' | 'configure' | 'rollover' }>;

/** Forward the caller's invocation identity and exact body; Session owns key/body
 * conflicts, original duplicates, reservation and physical effect admission.
 */
export function nativeCommandRequest(command: KeyedCommand): DirectCommandRequest {
  const commandId = command.commandId;
  const preconditions = {
    ...(command.admission !== undefined ? { admission: command.admission } : {}),
    ...(command.expectedRevision !== undefined ? { expectedRevision: command.expectedRevision } : {}),
  };
  switch (command.type) {
    case 'retry': return { commandId, ...preconditions, operation: { kind: 'retry', target: command.target,
      ...(command.executionId !== undefined ? { executionId: command.executionId as ExecutionId } : {}) } };
    case 'configure': return { commandId, ...preconditions, operation: { kind: 'configure', configuration: structuredClone(command.configuration) } };
    case 'rewind': return { commandId, ...preconditions, operation: { kind: 'rewind', targetId: command.targetId } };
    case 'compact': case 'rollover': return { commandId, ...preconditions, operation: { kind: command.type } };
  }
}

/** The native receipt schema is portable public data, not provider history or
 * runtime authority. Copy its original request, revision and optional outcome.
 */
export function publicCommandReceipt(receipt: DirectCommandReceipt): WireCommandReceipt {
  return structuredClone(receipt);
}

/** Preserve native pending/conflict/refusal and actual settled outcomes. A rejected
 * or interrupted receipt is a failure, never accepted or permission to run again.
 * Successful retry means admitted turnId only, not model/tool completion.
 */
export function publicCommandResult(commandId: string, result: DirectCommandResult): WireCommandResult {
  if (result.kind === 'conflict') return { ok: false, code: 'request_conflict', commandId, message: 'Command identity already belongs to a different request.' };
  if (result.kind === 'not_admitting') return { ok: false, code: 'not_admitting', commandId, message: result.reason };
  return receiptResult(publicCommandReceipt(result.receipt), result.kind, result.replayed);
}

/** Status reads have no first-vs-duplicate invocation claim. Only the native
 * command result supplies replayed; never infer it from a snapshot or timing.
 */
function receiptResult(receipt: WireCommandReceipt, kind: 'pending' | 'finished', replayed?: boolean): WireCommandResult {
  const replay = replayed === undefined ? {} : { replayed };
  if (kind === 'pending') return { ok: true, kind: 'command_pending', receipt, ...replay };
  const outcome = receipt.outcome;
  if (!outcome) throw new Error('Finished native command has no accepted outcome');
  if (outcome.kind === 'rejected' || outcome.kind === 'interrupted') return {
    ok: false, code: outcome.kind === 'rejected' ? 'command_rejected' : 'command_interrupted',
    commandId: receipt.request.commandId,
    message: outcome.kind === 'rejected' ? outcome.message : 'Command outcome was not observed; effects must not be replayed.',
    receipt: { ...receipt, outcome }, ...replay,
  };
  return { ok: true, kind: 'command_finished', receipt: { ...receipt, outcome }, ...replay };
}

/** Read actual retained Session receipts after a cache miss; unknown is not
 * pending, failure, or a grant to execute. This operation never calls command().
 */
export function commandStatus(session: DirectSession, commandId: string): WireCommandResult {
  const capture = session.capture(() => undefined);
  try {
    const receipt = capture.state.commands.find(receipt => receipt.request.commandId === commandId);
    return receipt
      ? receiptResult(publicCommandReceipt(receipt), receipt.outcome === undefined ? 'pending' : 'finished')
      : { ok: false, code: 'not_found', commandId, message: 'No retained command receipt has this identity.' };
  } finally { capture.unsubscribe(); }
}

/** One accepted native receipt fact becomes one session-scoped public frame with
 * the original receipt correlation. Retry turn identity stays in its outcome.
 */
export function commandFactEvent(fact: DirectCommandFact, state: WireSnapshot, seq: number): WireEvent {
  const envelope = { sessionId: state.sessionId, seq, turnId: null };
  if (fact.type === 'command_started') return { ...envelope, type: 'command_started', payload: {
    receipt: publicCommandReceipt({ request: fact.request, revision: fact.revision }),
  } };
  const receipt = state.commands?.find(receipt => receipt.request.commandId === fact.commandId);
  if (!receipt) throw new Error('Accepted command finish has no reconstructed start receipt');
  return { ...envelope, type: 'command_finished', payload: { receipt: { ...receipt, outcome: structuredClone(fact.outcome) } } };
}
