import { randomUUID } from 'node:crypto';
import type { TuiConnection } from './integration.js';
import type { WireCommandResult, WireContent, WireBudgetDecision, WireDecision, WireSubmission } from '../../protocol/direct-wire.js';

export class WireCommandFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function requireAccepted(result: WireCommandResult): void {
  if (!result.ok) throw new WireCommandFailure(result.code, result.message);
  if (result.kind !== 'accepted') throw new Error(`Unexpected command response: ${result.kind}`);
}

/** Submit a fresh message; a successful admission is not turn completion. */
export async function submitText(connection: TuiConnection, text: string, attachments: readonly WireContent[] = [], delivery: WireSubmission['delivery'] = 'auto'): Promise<void> {
  const result = await connection.send({ type: 'submit', requestId: randomUUID(), text, delivery, ...(attachments.length ? { attachments } : {}), origin: { kind: 'tui' } });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  if (result.kind !== 'admitted') throw new Error(`Unexpected submit response: ${result.kind}`);
  const admission = result.admission.kind === 'duplicate' ? result.admission.original : result.admission;
  if (admission.kind === 'rejected') throw new Error(admission.reason);
}

/** Resolve exactly the identified pending request through the direct protocol. */
export async function answerInteraction(connection: TuiConnection, requestId: string, decision: WireDecision): Promise<void> {
  requireAccepted(await connection.send({ type: 'answer', requestId, decision, provenance: { source: 'user' } }));
}

/** Request foreground cancellation without closing the connection. */
export async function cancelForeground(connection: TuiConnection, expectedTurnId?: string): Promise<string> {
  const result = await connection.send({ type: 'cancel', ...(expectedTurnId ? { expectedTurnId } : {}) });
  if (!result.ok) throw new WireCommandFailure(result.code, result.message);
  if (result.kind === 'accepted') return 'Cancellation requested.';
  if (result.kind !== 'abort') throw new Error(`Unexpected cancellation response: ${result.kind}`);
  if (result.result.kind === 'aborted') return `Cancellation requested for ${result.result.turnId}; cleanup may still be running.${result.result.discardedMessageIds.length ? ` Discarded queued messages: ${result.result.discardedMessageIds.join(', ')}.` : ''}`;
  return `Cancellation ${result.result.kind.replace('_', ' ')}${result.result.reason ? `: ${result.result.reason}` : '.'}`;
}

/** Resolve the exact budget request using explicit human provenance. */
export async function answerBudget(connection: TuiConnection, requestId: string, decision: WireBudgetDecision): Promise<void> {
  requireAccepted(await connection.send({ type: 'answer_budget', requestId, decision, provenance: { source: 'user' } }));
}

/** Handle slash operations with unambiguous direct wire equivalents; return false for app-owned commands. */
export async function directSlashCommand(connection: TuiConnection, input: string): Promise<boolean> {
  switch (input.trim()) {
    case '/compact': requireAccepted(await connection.send({ type: 'compact' })); return true;
    case '/retry-turn': requireAccepted(await connection.send({ type: 'retry', target: 'turn' })); return true;
    case '/retry-tool': requireAccepted(await connection.send({ type: 'retry', target: 'tool' })); return true;
    default: return false;
  }
}

/** Perform a typed queued-message operation; unavailable remains an error. */
export async function queueAction(connection: TuiConnection, action: 'edit' | 'retract' | 'resume' | 'discard', messageId?: string, text?: string, attachments?: readonly WireContent[]): Promise<void> {
  switch (action) {
    case 'edit':
      if (!messageId || text === undefined) throw new Error('A queued message and replacement text are required.');
      requireAccepted(await connection.send({ type: 'queue_edit', messageId, text, ...(attachments !== undefined ? { attachments } : {}) })); return;
    case 'retract':
      if (!messageId) throw new Error('Select a queued message.');
      requireAccepted(await connection.send({ type: 'queue_retract', messageId })); return;
    case 'resume': requireAccepted(await connection.send({ type: 'queue_resume' })); return;
    case 'discard': requireAccepted(await connection.send({ type: 'queue_discard' })); return;
  }
}

/** Query the real rewind targets; unavailable or malformed replies are errors. */
export async function listRewindTargets(connection: TuiConnection) {
  const result = await connection.send({ type: 'list_rewind_targets' });
  if (!result.ok) throw new WireCommandFailure(result.code, result.message);
  if (result.kind !== 'rewind_targets') throw new Error(`Unexpected rewind targets response: ${result.kind}`);
  return result.targets;
}

/** Rewind to the chosen stable ID and return the Session-owned editable draft. */
export async function rewindTo(connection: TuiConnection, targetId: string) {
  const result = await connection.send({ type: 'rewind', targetId });
  if (!result.ok) throw new WireCommandFailure(result.code, result.message);
  if (result.kind !== 'rewound') throw new Error(`Unexpected rewind response: ${result.kind}`);
  return result.draft;
}

/** Change direct session; the app must attach the returned ID. */
export async function changeSession(connection: TuiConnection, type: 'reset' | 'rollover'): Promise<string> {
  const result = await connection.send({ type });
  if (!result.ok) throw new WireCommandFailure(result.code, result.message);
  if (result.kind !== 'session_changed') throw new Error(`Unexpected session response: ${result.kind}`);
  return result.sessionId;
}

/** Request a specific task operation; an acknowledgement is not task completion. */
export async function controlTask(connection: TuiConnection, taskId: string, action: 'cancel' | 'check_in' | 'foreground' | 'background'): Promise<void> {
  requireAccepted(await connection.send({ type: 'task_control', taskId, action }));
}
