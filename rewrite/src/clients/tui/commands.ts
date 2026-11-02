import { randomUUID } from 'node:crypto';
import type { TuiConnection } from './integration.js';
import type {
  WireCommand,
  WireCommandReceipt,
  WireCommandResult,
  WireContent,
  WireBudgetDecision,
  WireDecision,
  WireSubmission,
} from '../../protocol/direct-wire.js';

export class WireCommandFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
function requireAccepted(result: WireCommandResult): void {
  if (!result.ok) throw new WireCommandFailure(result.code, result.message);
  if (result.kind !== 'accepted') throw new Error(`Unexpected command response: ${result.kind}`);
}

/** Submit a fresh message; a successful admission is not turn completion. */
export async function submitText(
  connection: TuiConnection,
  text: string,
  attachments: readonly WireContent[] = [],
  delivery: WireSubmission['delivery'] = 'auto',
  expectedSteerTurnId?: string,
  requestId = randomUUID(),
  skill?: { readonly name: string; readonly request: string },
): Promise<void> {
  const result = await connection.send({
    type: 'submit',
    requestId,
    text,
    delivery,
    ...(expectedSteerTurnId && delivery === 'steer' ? { expectedSteerTurnId } : {}),
    ...(attachments.length ? { attachments } : {}),
    origin: { kind: 'tui', ...(skill ? { skill } : {}) },
  });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  if (result.kind !== 'admitted') throw new Error(`Unexpected submit response: ${result.kind}`);
  const admission = result.admission.kind === 'duplicate' ? result.admission.original : result.admission;
  if (admission.kind === 'rejected') {
    if (admission.reason === 'steer_target_stopped')
      throw new WireCommandFailure('steer_target_stopped', 'The turn stopped; your message is back in the input.');
    throw new Error(admission.reason);
  }
}

/**
 * Ask the session whether this exact draft needs human confirmation (input surge or
 * large uncached input). Returns the notice to show, or null when it may be sent.
 * A preview failure throws: an unavailable preview is never an allow decision.
 */
export async function previewConfirmation(
  connection: TuiConnection,
  text: string,
  attachments: readonly WireContent[] = [],
): Promise<string | null> {
  const result = await connection.send({ type: 'preview', text, ...(attachments.length ? { attachments } : {}) });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  if (result.kind !== 'preview') throw new Error(`Unexpected preview response: ${result.kind}`);
  if (!result.requiresConfirmation) return null;
  return result.notices.map((notice) => notice.message).join(' ') || 'Confirmation required before sending.';
}

/** Resolve exactly the identified pending request through the direct protocol. */
export async function answerInteraction(
  connection: TuiConnection,
  requestId: string,
  decision: WireDecision,
): Promise<void> {
  requireAccepted(await connection.send({ type: 'answer', requestId, decision, provenance: { source: 'user' } }));
}

/** Cancel once; returned steer content is the exact batch accepted by Session. */
export async function cancelForegroundWithSteers(
  connection: TuiConnection,
  expectedTurnId?: string,
): Promise<{
  readonly message: string;
  readonly returnedSteers: readonly {
    readonly messageId: string;
    readonly clientRequestId: string;
    readonly content: readonly WireContent[];
  }[];
}> {
  const result = await connection.send({
    type: 'cancel',
    ...(expectedTurnId ? { expectedTurnId, discardQueue: false, returnSteers: true } : {}),
  });
  if (!result.ok) throw new WireCommandFailure(result.code, result.message);
  if (result.kind === 'accepted') return { message: 'Cancellation requested.', returnedSteers: [] };
  if (result.kind !== 'abort') throw new Error(`Unexpected cancellation response: ${result.kind}`);
  if (result.result.kind === 'aborted') {
    const returnedSteers = result.result.returnedSteers ?? [];
    return {
      message: returnedSteers.length
        ? 'Cancelled. Your queued message is back in the input.'
        : `Cancellation requested for ${result.result.turnId}; cleanup may still be running.`,
      returnedSteers,
    };
  }
  return {
    message: `Cancellation ${result.result.kind.replace('_', ' ')}${
      result.result.reason ? `: ${result.result.reason}` : '.'
    }`,
    returnedSteers: [],
  };
}

/** Compatibility helper: request cancellation without consuming returned draft content. */
export async function cancelForeground(connection: TuiConnection, expectedTurnId?: string): Promise<string> {
  const result = await connection.send({
    type: 'cancel',
    ...(expectedTurnId ? { expectedTurnId, discardQueue: false } : {}),
  });
  if (!result.ok) throw new WireCommandFailure(result.code, result.message);
  if (result.kind === 'accepted') return 'Cancellation requested.';
  if (result.kind !== 'abort') throw new Error(`Unexpected cancellation response: ${result.kind}`);
  if (result.result.kind === 'aborted')
    return `Cancellation requested for ${result.result.turnId}; cleanup may still be running.${
      result.result.discardedMessageIds.length
        ? ` Discarded queued messages: ${result.result.discardedMessageIds.join(', ')}.`
        : ''
    }`;
  return `Cancellation ${result.result.kind.replace('_', ' ')}${
    result.result.reason ? `: ${result.result.reason}` : '.'
  }`;
}

/** Resolve the exact budget request using explicit human provenance. */
export async function answerBudget(
  connection: TuiConnection,
  requestId: string,
  decision: WireBudgetDecision,
): Promise<void> {
  requireAccepted(
    await connection.send({ type: 'answer_budget', requestId, decision, provenance: { source: 'user' } }),
  );
}

/** A single keyed invocation is sent once; transport uncertainty never triggers a repeat. */
export type NativeReceiptResult =
  | { readonly kind: 'pending'; readonly receipt: WireCommandReceipt }
  | { readonly kind: 'finished'; readonly receipt: WireCommandReceipt }
  | {
      readonly kind: 'rejected' | 'interrupted' | 'error' | 'uncertain';
      readonly commandId: string;
      readonly message: string;
      readonly receipt?: WireCommandReceipt;
    };

type NativeCommand = Extract<WireCommand, { type: 'retry' | 'compact' | 'configure' | 'rewind' | 'rollover' }>;

/** Preserve the caller's invocation identity even when transport loses its reply. */
export async function sendNativeCommand(
  connection: TuiConnection,
  command: NativeCommand,
): Promise<NativeReceiptResult> {
  try {
    return nativeResult(command.commandId, await connection.send(command));
  } catch (error) {
    return {
      kind: 'uncertain',
      commandId: command.commandId,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function nativeResult(commandId: string, result: WireCommandResult): NativeReceiptResult {
  if (!result.ok)
    return {
      kind:
        result.code === 'command_rejected'
          ? 'rejected'
          : result.code === 'command_interrupted'
          ? 'interrupted'
          : ['request_conflict', 'not_admitting', 'forbidden', 'invalid_command'].includes(result.code)
          ? 'error'
          : 'uncertain',
      commandId,
      message: `${result.code}: ${result.message}`,
      ...('receipt' in result ? { receipt: result.receipt } : {}),
    };
  if (result.kind === 'command_pending') return { kind: 'pending', receipt: result.receipt };
  if (result.kind === 'command_finished') return { kind: 'finished', receipt: result.receipt };
  return { kind: 'uncertain', commandId, message: `Unexpected response: ${result.kind}` };
}

/** Read only; never re-execute a command when its status is unknown or absent. */
export async function commandStatus(connection: TuiConnection, commandId: string): Promise<NativeReceiptResult> {
  try {
    return nativeResult(commandId, await connection.send({ type: 'command_status', commandId }));
  } catch (error) {
    return { kind: 'uncertain', commandId, message: error instanceof Error ? error.message : String(error) };
  }
}

export function receiptNotice(result: NativeReceiptResult): string {
  if (result.kind === 'pending')
    return `Command ${result.receipt.request.commandId} pending (not completed); do not repeat it. Use /command-status ${result.receipt.request.commandId}.`;
  if (result.kind === 'finished') {
    const { request, outcome } = result.receipt;
    return `Command ${request.commandId} finished: ${outcome?.kind ?? 'outcome unavailable'}.${
      outcome?.kind === 'rewound' || outcome?.kind === 'rolled_over'
        ? ` Use /command-apply ${request.commandId} to apply the result.`
        : ''
    }`;
  }
  return `Command ${result.commandId} ${result.kind}: ${result.message}${
    result.kind === 'uncertain' || result.kind === 'interrupted'
      ? ` Outcome may be unknown; use /command-status ${result.commandId}; do not repeat blindly.`
      : ''
  }`;
}

function directCommandNotice(result: NativeReceiptResult): string {
  if (result.kind === 'rejected' || result.kind === 'error') throw new Error(receiptNotice(result));
  if (result.kind === 'finished' && result.receipt.outcome?.kind === 'retried') return 'Retrying.';
  return receiptNotice(result);
}

/** Handle direct slash operations without treating a pending receipt as success. */
export async function directSlashCommand(connection: TuiConnection, input: string): Promise<string | null> {
  const commandId = randomUUID();
  switch (input.trim()) {
    case '/compact': {
      const result = await sendNativeCommand(connection, { type: 'compact', commandId });
      if (result.kind === 'finished' && result.receipt.outcome?.kind === 'compacted') return 'Compaction complete.';
      if (result.kind === 'rejected' || result.kind === 'error') {
        const outcome = result.receipt?.outcome;
        const message = outcome?.kind === 'rejected' ? outcome.message : result.message.replace(/^[a-z_]+: /, '');
        return message === 'Compaction did not replace history: no_complete_cold_turn.'
          ? 'Nothing to compact yet.'
          : `Compaction failed: ${message}`;
      }
      return receiptNotice(result);
    }
    case '/retry':
    case '/retry-turn':
      return directCommandNotice(await sendNativeCommand(connection, { type: 'retry', commandId, target: 'turn' }));
    case '/retry-tool':
      return directCommandNotice(await sendNativeCommand(connection, { type: 'retry', commandId, target: 'tool' }));
    default:
      return null;
  }
}

/** Perform a typed queued-message operation; unavailable remains an error. */
export async function queueAction(
  connection: TuiConnection,
  action: 'edit' | 'retract' | 'resume' | 'discard',
  messageId?: string,
  text?: string,
  attachments?: readonly WireContent[],
): Promise<void> {
  switch (action) {
    case 'edit':
      if (!messageId || text === undefined) throw new Error('A queued message and replacement text are required.');
      requireAccepted(
        await connection.send({
          type: 'queue_edit',
          messageId,
          text,
          ...(attachments !== undefined ? { attachments } : {}),
        }),
      );
      return;
    case 'retract':
      if (!messageId) throw new Error('Select a queued message.');
      requireAccepted(await connection.send({ type: 'queue_retract', messageId }));
      return;
    case 'resume':
      requireAccepted(await connection.send({ type: 'queue_resume' }));
      return;
    case 'discard':
      requireAccepted(await connection.send({ type: 'queue_discard' }));
      return;
  }
}

/** Query the real rewind targets; unavailable or malformed replies are errors. */
export async function listRewindTargets(connection: TuiConnection) {
  const result = await connection.send({ type: 'list_rewind_targets' });
  if (!result.ok) throw new WireCommandFailure(result.code, result.message);
  if (result.kind !== 'rewind_targets') throw new Error(`Unexpected rewind targets response: ${result.kind}`);
  return result.targets;
}

/** Reset has a direct successor response; rollover uses the keyed native command. */
export async function resetSession(connection: TuiConnection): Promise<string> {
  const result = await connection.send({ type: 'reset' });
  if (!result.ok) throw new WireCommandFailure(result.code, result.message);
  if (result.kind !== 'session_changed') throw new Error(`Unexpected session response: ${result.kind}`);
  return result.sessionId;
}

/** Request a specific task operation; an acknowledgement is not task completion. */
export async function controlTask(
  connection: TuiConnection,
  taskId: string,
  action: 'cancel' | 'check_in' | 'foreground' | 'background',
): Promise<void> {
  requireAccepted(await connection.send({ type: 'task_control', taskId, action }));
}
