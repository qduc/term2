/** The only inbound wire-to-domain translation. No engine/bridge execution or second writer. */
import type { DirectTaskControlResult } from '../session/direct-background-types.js';
import type { DirectQueueMutation } from '../session/direct-queue-types.js';
import type { DirectSession, DirectSubmission } from '../session/facade-types.js';
import type { InteractionRequestId } from '../tools/index.js';
import type { DirectCommandCapabilities } from './direct-capabilities.js';
import type { AnswerResult } from '../session/direct-types.js';
import { serializeQuestionAnswers } from './direct-questions.js';
import type { WireCommand, WireCommandResult, WireDecision } from './direct-wire.js';
import { DirectProtocolError } from './direct-errors.js';
import { parseWireCommand } from './direct-parse.js';

/** Convert failures without disclosing unexpected runtime exception text to remote clients. */
export async function applyDirectCommand(
  session: DirectSession, input: unknown, capabilities: DirectCommandCapabilities = {},
): Promise<WireCommandResult> {
  try { return await dispatch(session, parseWireCommand(input), capabilities); }
  catch (error) {
    if (error instanceof DirectProtocolError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'internal_error', message: 'Session command failed.' };
  }
}
const accepted = { ok: true, kind: 'accepted' } as const;
function requireOperation<T>(operation: T | undefined, name: string): T {
  if (!operation) throw new DirectProtocolError('unavailable', `Session operation is unavailable: ${name}`);
  return operation;
}
async function dispatch(session: DirectSession, command: WireCommand, operations: DirectCommandCapabilities): Promise<WireCommandResult> {
  switch (command.type) {
    case 'submit':
    {
      const request: DirectSubmission = { clientRequestId: command.requestId,
        content: [{ type: 'text', text: command.text }, ...(command.attachments ?? [])],
        ...(command.origin ? { origin: command.origin } : {}) };
      const delivery = command.delivery ?? 'auto';
      // Structured Discord authority must use the real queue/delivery admission path,
      // whose immutable fingerprint includes every origin field (never M2 kind/id).
      const admission = delivery === 'auto' && command.origin?.kind !== 'discord' ? await session.submit(request)
        : await requireOperation(operations.submitWithDelivery, `submit:${delivery}`).call(operations, request, delivery === 'auto' ? 'follow_up' : delivery);
      return { ok: true, kind: 'admitted', admission };
    }
    case 'answer': {
      const answer = await answerInteraction(session, command.requestId, command.decision, operations);
      return answerResult(answer);
    }
    case 'cancel':
      if (command.expectedTurnId !== undefined) {
        const result = await requireOperation(operations.cancelForeground, 'atomic expected-turn cancel').call(operations, command.expectedTurnId);
        return result.kind === 'accepted' ? accepted : { ok: false, code: 'rejected', message: 'Expected turn is no longer active.' };
      }
      if (command.target?.kind === 'task') return taskResult(await requireOperation(operations.controlTask, 'task cancel').call(operations, command.target.id, 'cancel'));
      session.cancel(command.target); return accepted;
    case 'retry': await requireOperation(operations.retry, 'retry').call(operations, { target: command.target, ...(command.executionId ? { executionId: command.executionId } : {}) }); return accepted;
    case 'compact': await requireOperation(operations.compact, 'compact').call(operations); return accepted;
    case 'configure': await requireOperation(operations.configure, 'configure').call(operations, command.configuration); return accepted;
    case 'queue_edit': return queueResult(await requireOperation(operations.editQueue, 'queue_edit').call(operations, command.messageId, { text: command.text, ...(command.attachments !== undefined ? { attachments: command.attachments } : {}) }));
    case 'queue_retract': return queueResult(await requireOperation(operations.retractQueue, 'queue_retract').call(operations, command.messageId));
    case 'queue_resume': return queueResult(await requireOperation(operations.resumeQueue, 'queue_resume').call(operations));
    case 'queue_discard': return queueResult(await requireOperation(operations.discardQueue, 'queue_discard').call(operations));
    case 'task_control': return taskResult(await requireOperation(operations.controlTask, 'task_control').call(operations, command.taskId, command.action));
    case 'list_rewind_targets': return { ok: true, kind: 'rewind_targets', targets: await requireOperation(operations.listRewindTargets, 'list_rewind_targets').call(operations) };
    case 'rewind': return { ok: true, kind: 'rewound', ...await requireOperation(operations.rewind, 'rewind').call(operations, command.targetId) };
    case 'reset': return { ok: true, kind: 'session_changed', ...await requireOperation(operations.reset, 'reset').call(operations) };
    case 'rollover': return { ok: true, kind: 'session_changed', ...await requireOperation(operations.rollover, 'rollover').call(operations) };
    case 'preview': return { ok: true, kind: 'preview', ...await requireOperation(operations.preview, 'preview').call(operations, { text: command.text, ...(command.attachments !== undefined ? { attachments: command.attachments } : {}) }) };
  }
}

function answerResult(answer: AnswerResult): WireCommandResult {
  if (answer.kind === 'accepted') return accepted;
  if (answer.kind === 'stale') return { ok: false, code: 'stale_interaction', message: 'Interaction is no longer answerable.' };
  return { ok: false, code: 'storage_failure', message: 'Interaction resolution could not be committed.' };
}
/** Structured question serialization is not effect authority: the final specific-target
 * resolution still goes through the actual synchronous Session answer operation.
 */
async function answerInteraction(session: DirectSession, requestId: string, decision: WireDecision, operations: DirectCommandCapabilities): Promise<AnswerResult> {
  if (decision.kind === 'grant') return requireOperation(operations.grant, 'scoped approval grants').call(operations, requestId, decision.grant, decision.stopAfterApprovalResolution);
  if (decision.kind === 'answers') {
    const capture = session.capture(() => undefined);
    const request = capture.state.pendingInteractions.find(request => request.requestId === requestId);
    capture.unsubscribe();
    if (!request) return { kind: 'stale' };
    const answer = serializeQuestionAnswers(request, decision.answers);
    return session.answer(requestId as InteractionRequestId, { kind: 'answer', answer,
      ...(decision.stopAfterApprovalResolution !== undefined ? { stopAfterApprovalResolution: decision.stopAfterApprovalResolution } : {}) });
  }
  if (decision.kind === 'decline') return session.answer(requestId as InteractionRequestId, { kind: 'answer', answer: 'User declined to answer.',
    ...(decision.stopAfterApprovalResolution !== undefined ? { stopAfterApprovalResolution: decision.stopAfterApprovalResolution } : {}) });
  return session.answer(requestId as InteractionRequestId, decision);
}

/** Planner outcomes are effects only after the owning Session has durably accepted them. */
function queueResult(result: DirectQueueMutation): WireCommandResult {
  if (result.kind === 'accepted' || result.kind === 'no_op') return accepted;
  if (result.kind === 'too_late') return { ok: false, code: 'too_late', message: 'Queued input is no longer editable or retractable.' };
  return { ok: false, code: 'invalid_command', message: 'Queue mutation was rejected.' };
}

function taskResult(result: DirectTaskControlResult | { readonly ok: true }): WireCommandResult {
  if (result.ok) return accepted;
  return { ok: false, code: result.code === 'not_found' ? 'not_found' : 'rejected', message: `Task control rejected: ${result.code}` };
}
