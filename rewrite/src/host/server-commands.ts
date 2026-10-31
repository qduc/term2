/** Translate pinned HTTP command IDs to stable native invocation keys. Session remains the only
 * acceptance/receipt authority; this adapter never retries effects, caches outcomes or allocates IDs.
 */
import type { WireCommand, WireCommandReceipt } from '../protocol/direct-wire.js';
import type { ServerResult, ServerSessionRequest } from './server-contracts.js';
import { commandFailure, publicError, unavailable } from './server-errors.js';

type CommandBody = { commandId: string; clientRequestId: string };
/** A native receipt is admission evidence, not an assumed successful terminal. Same-key lookups are
 * allowed while a later turn runs. Missing outcomes and interrupted recovery stay explicitly unknown.
 */
export async function invokeServerCommand(input: ServerSessionRequest, body: CommandBody): Promise<ServerResult> {
  const { connection } = input;
  let command: WireCommand;
  switch (body.commandId) {
    case 'compact':
      command = { type: 'compact', commandId: body.clientRequestId };
      break;
    case 'retry-tool':
    case 'retry-turn':
      command = {
        type: 'retry',
        commandId: body.clientRequestId,
        target: body.commandId === 'retry-tool' ? 'tool' : 'turn',
      };
      break;
    default:
      return publicError(422, 'command_not_allowed', 'command is not allowed');
  }
  // Status is read-only and helps avoid refusing an existing invocation while a later turn runs.
  // It makes no replay claim. Always invoke the SAME keyed command for the native replayed flag;
  // Session receipt inspection guarantees this cannot grant a second execution for an existing ID.
  const lookup = await connection.send({ type: 'command_status', commandId: body.clientRequestId });
  if (!lookup.ok && lookup.code === 'not_found') {
    if (connection.snapshot.status === 'running' || connection.snapshot.status === 'awaiting_interaction')
      return publicError(409, 'session_busy', 'session is busy');
  } else if ('receipt' in lookup) {
    if (!matches(lookup.receipt, body))
      return publicError(409, 'idempotency_conflict', 'request conflicts with an existing command');
  } else return lookup.ok ? unavailable('durable command receipt') : commandFailure(lookup);
  const result = await connection.send(command);
  if (!result.ok && result.code !== 'command_rejected' && result.code !== 'command_interrupted')
    return commandFailure(result);
  if (result.ok && result.kind !== 'command_pending' && result.kind !== 'command_finished')
    return unavailable('durable command receipt');
  // Both successful and negative keyed results retain the exact original body and outcome.
  if (!('receipt' in result)) return unavailable('durable command receipt');
  const { receipt } = result;
  if (!matches(receipt, body))
    return publicError(409, 'idempotency_conflict', 'request conflicts with an existing command');
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
      return publicError(
        409,
        'command_outcome_unobserved',
        'command outcome was not observed; do not resubmit with a new key',
        false,
        {
          clientRequestId: body.clientRequestId,
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
            clientRequestId: body.clientRequestId,
            accepted: true,
          });
        case 'unavailable':
          // This invocation is durably rejected, not pending. Same-key retry cannot turn the
          // original receipt into a newly supported operation after a runtime upgrade.
          return publicError(503, 'command_unavailable', 'native command operation is unavailable', false, {
            clientRequestId: body.clientRequestId,
          });
      }
    default:
      return unavailable('matching durable command outcome');
  }
}
function matches(receipt: WireCommandReceipt, body: CommandBody): boolean {
  if (receipt.request.commandId !== body.clientRequestId) return false;
  const { operation } = receipt.request;
  if (body.commandId === 'compact') return operation.kind === 'compact';
  return (
    operation.kind === 'retry' &&
    operation.target === (body.commandId === 'retry-tool' ? 'tool' : 'turn') &&
    operation.executionId === undefined
  );
}
