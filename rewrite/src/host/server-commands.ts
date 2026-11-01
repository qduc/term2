/** Translate pinned HTTP command IDs to stable native invocation keys. Session remains the only
 * acceptance/receipt authority; this adapter never retries effects, caches outcomes or allocates IDs.
 */
import type { WireCommand, WireCommandReceipt, WireCommandResult } from '../protocol/direct-wire.js';
import type { CommandBody, ServerResult, ServerSessionRequest } from './server-contracts.js';
import { commandFailure, publicError, unavailable } from './server-errors.js';

/** A native receipt is admission evidence, not an assumed successful terminal. Same-key lookups are
 * allowed while a later turn runs. Missing outcomes and interrupted recovery stay explicitly unknown.
 */
export async function invokeServerCommand(input: ServerSessionRequest, body: CommandBody): Promise<ServerResult> {
  const { connection } = input;
  // Preserve HTTP's idle-only policy at the real writer, not a snapshot preflight.
  const preconditions = {
    admission: 'idle' as const,
    ...(body.expectedRevision !== undefined ? { expectedRevision: body.expectedRevision } : {}),
  };
  let command: WireCommand;
  switch (body.commandId) {
    case 'compact':
      command = { type: 'compact', commandId: body.clientRequestId, ...preconditions };
      break;
    case 'retry-tool':
    case 'retry-turn':
      command = {
        type: 'retry',
        commandId: body.clientRequestId,
        ...preconditions,
        target: body.commandId === 'retry-tool' ? 'tool' : 'turn',
      };
      break;
    default:
      return publicError(422, 'command_not_allowed', 'command is not allowed');
  }
  // Always invoke the same caller key. Native equality includes all requested
  // fields/preconditions and precedes fresh idle/stale rejection, even during later work.
  const result = await connection.send(command);
  if (input.url.searchParams.get('format') === 'direct') return projectServerNativeCommand(result);
  if (!result.ok && result.code !== 'command_rejected' && result.code !== 'command_interrupted')
    return commandFailure(result);
  if (result.ok && result.kind !== 'command_pending' && result.kind !== 'command_finished')
    return unavailable('durable command receipt');
  // Both successful and negative keyed results retain the exact original body and outcome.
  if (!('receipt' in result)) return unavailable('durable command receipt');
  const { receipt } = result;
  const response = projectReceipt(body, receipt, result.ok && result.kind === 'command_pending');
  // Forward only native invocation provenance, including failed/interrupted receipts. Status,
  // snapshot state and accepted command facts never establish first-vs-duplicate invocation.
  return typeof result.replayed === 'boolean' && response.body && typeof response.body === 'object'
    ? { ...response, body: { ...response.body, replayed: result.replayed } }
    : response;
}
function projectReceipt(body: CommandBody, receipt: WireCommandReceipt, pending: boolean): ServerResult {
  if (pending)
    return {
      status: 202,
      body: { commandId: body.commandId, clientRequestId: body.clientRequestId, outcome: 'pending' },
    };
  const { outcome } = receipt;
  if (!outcome) return unavailable('durable command outcome');
  switch (outcome.kind) {
    case 'retried':
      if (body.commandId === 'compact') return unavailable('matching durable command outcome');
      return {
        status: 200,
        body: { commandId: body.commandId, outcome: 'accepted', turnId: outcome.turnId },
      };
    case 'compacted':
      if (body.commandId !== 'compact') return unavailable('matching durable command outcome');
      return { status: 200, body: { commandId: 'compact', outcome: 'completed' } };
    case 'interrupted':
    case 'rejected':
      return projectNegativeReceipt(receipt);
    default:
      return unavailable('matching durable command outcome');
  }
}
/** Project native receipts without pretending pending/replayed work is a new installed
 * configuration. Retain request/revision/outcome identity; redact diagnostic text only. */
export function projectServerNativeCommand(result: WireCommandResult): ServerResult {
  if (!('receipt' in result)) return result.ok ? unavailable('durable command receipt') : commandFailure(result);
  return { status: result.ok ? (result.kind === 'command_pending' ? 202 : 200) : projectNegativeReceipt(result.receipt).status,
    body: safeNativeCommandResult(result) };
}
/** Retain structural receipt evidence while applying the established safe diagnostic redaction. */
export function safeNativeCommandResult(result: WireCommandResult): WireCommandResult {
  if (!('receipt' in result))
    return result.ok ? result : { ...result, message: 'Native command did not complete successfully.' };
  const { receipt } = result;
  const safeReceipt =
    receipt.outcome?.kind === 'rejected'
      ? { ...receipt, outcome: { ...receipt.outcome, message: 'Native command was rejected.' } }
      : receipt;
  return result.ok
    ? { ...result, receipt: safeReceipt }
    : { ...result, message: 'Native command did not complete successfully.', receipt: safeReceipt };
}
function projectNegativeReceipt(receipt: WireCommandReceipt): ServerResult {
  const { outcome } = receipt;
  if (!outcome) return unavailable('durable command outcome');
  switch (outcome.kind) {
    case 'interrupted':
      return publicError(
        409,
        'command_outcome_unobserved',
        'command outcome was not observed; do not resubmit with a new key',
        false,
        {
          clientRequestId: receipt.request.commandId,
          accepted: true,
        },
      );
    case 'rejected':
      switch (outcome.code) {
        case 'busy':
          return publicError(409, 'session_busy', 'session is busy');
        case 'stale':
          return publicError(409, 'command_stale', 'command target is stale');
        case 'ineligible':
          // Ineligible also covers unsafe history cuts, not merely nothing_to_retry.
          return publicError(409, 'command_ineligible', 'command is not eligible');
        case 'cancelled':
          return publicError(409, 'command_cancelled', 'command was cancelled');
        case 'failed':
          return publicError(503, 'command_failed', 'command failed; retry only with the same key', false, {
            clientRequestId: receipt.request.commandId,
            accepted: true,
          });
        case 'unavailable':
          // This invocation is durably rejected, not pending. Same-key retry cannot turn the
          // original receipt into a newly supported operation after a runtime upgrade.
          return publicError(503, 'command_unavailable', 'native command operation is unavailable', false, {
            clientRequestId: receipt.request.commandId,
          });
      }
    default:
      return unavailable('negative durable command outcome');
  }
}
