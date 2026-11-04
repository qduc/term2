/** The only inbound wire-to-domain translation. No engine/bridge execution or second writer. */
import { commandStatus, nativeCommandRequest, publicCommandResult } from './direct-command-receipts.js';
import type { DirectTaskControlResult } from '../session/direct-background-types.js';
import type { DirectQueueMutation } from '../session/direct-queue-types.js';
import type { DirectSession, DirectSubmission } from '../session/facade-types.js';
import type { BudgetDecision } from '../engine/direct-types.js';
import type { TurnId } from '../engine/index.js';
import type { InteractionRequestId } from '../tools/index.js';
import type { DirectCommandCapabilities } from './direct-capabilities.js';
import type { AnswerResult } from '../session/direct-types.js';
import { serializeQuestionAnswers } from './direct-questions.js';
import type { WireAnswerProvenance, WireCommand, WireCommandResult, WireDecision } from './direct-wire.js';
import { DirectProtocolError } from './direct-errors.js';
import { parseWireCommand } from './direct-parse.js';

/** Convert failures without disclosing unexpected runtime exception text to remote clients. */
export async function applyDirectCommand(
  session: DirectSession,
  input: unknown,
  capabilities: DirectCommandCapabilities = {},
): Promise<WireCommandResult> {
  let command: WireCommand | undefined;
  try {
    command = parseWireCommand(input);
    return await dispatch(session, command, capabilities);
  } catch (error) {
    const identity = command && 'commandId' in command ? { commandId: command.commandId } : {};
    if (error instanceof DirectProtocolError)
      return { ok: false, code: error.code, message: error.message, ...identity };
    return { ok: false, code: 'internal_error', message: 'Session command failed.', ...identity };
  }
}
const accepted = { ok: true, kind: 'accepted' } as const;
function requireOperation<T>(operation: T | undefined, name: string): T {
  if (!operation) throw new DirectProtocolError('unavailable', `Session operation is unavailable: ${name}`);
  return operation;
}
async function dispatch(
  session: DirectSession,
  command: WireCommand,
  operations: DirectCommandCapabilities,
): Promise<WireCommandResult> {
  switch (command.type) {
    case 'submit': {
      const request: DirectSubmission = {
        clientRequestId: command.requestId,
        content: [{ type: 'text', text: command.text }, ...(command.attachments ?? [])],
        ...(command.origin ? { origin: command.origin } : {}),
      };
      const delivery = command.delivery ?? 'auto';
      const admission = await session.submitWithDelivery(
        { ...request, delivery },
        command.expectedSteerTurnId as TurnId | undefined,
      );
      return { ok: true, kind: 'admitted', admission };
    }
    case 'answer': {
      const answer = await answerInteraction(
        session,
        command.requestId,
        command.decision,
        operations,
        command.provenance,
      );
      return answerResult(answer);
    }
    case 'answer_budget':
      return answerResult(
        session.answerBudget(
          command.requestId as InteractionRequestId,
          command.decision as BudgetDecision,
          command.provenance,
        ),
      );
    case 'cancel':
      if (command.expectedTurnId !== undefined) {
        return {
          ok: true,
          kind: 'abort',
          result: session.abort(command.expectedTurnId as TurnId, command.discardQueue, command.returnSteers),
        };
      }
      if (command.target?.kind === 'task')
        return taskResult(
          operations.controlTask
            ? await operations.controlTask(command.target.id, 'cancel')
            : session.requestTaskStop(command.target.id),
        );
      session.cancel(command.target);
      return accepted;
    case 'retry':
    case 'compact':
    case 'configure':
    case 'rewind':
    case 'rollover':
      return publicCommandResult(command.commandId, await session.command(nativeCommandRequest(command)));
    case 'command_status':
      return commandStatus(session, command.commandId);
    case 'command_revision':
      return { ok: true, kind: 'command_revision', revision: session.commandRevision() };
    case 'drain_background_notifications': {
      const result = await session.drainBackgroundNotifications(command.requestId);
      return result.kind === 'not_admitting'
        ? { ok: false, code: 'not_admitting', message: result.reason }
        : { ok: true, kind: 'background_drain', result: structuredClone(result) };
    }
    case 'queue_edit':
      return queueResult(
        await session.editQueue(command.messageId, {
          text: command.text,
          ...(command.attachments !== undefined ? { attachments: command.attachments } : {}),
        }),
      );
    case 'queue_retract':
      return queueResult(await session.retractQueue(command.messageId));
    case 'queue_resume':
      return queueResult(await session.resumeQueue());
    case 'queue_discard':
      return queueResult(await session.discardQueue());
    case 'task_control':
      return taskResult(
        command.action === 'cancel' && !operations.controlTask
          ? session.requestTaskStop(command.taskId)
          : await requireOperation(operations.controlTask, 'task_control').call(
              operations,
              command.taskId,
              command.action,
            ),
      );
    case 'list_rewind_targets':
      return {
        ok: true,
        kind: 'rewind_targets',
        targets: session.rewindTargets().map(({ id, label, discardedTurns, discardedReplies, imageCount }) => ({
          id,
          label,
          discardedTurns,
          discardedReplies,
          imageCount,
        })),
      };
    case 'reset':
      return {
        ok: true,
        kind: 'session_changed',
        ...(await requireOperation(operations.reset, 'reset').call(operations)),
      };
    case 'preview':
      return {
        ok: true,
        kind: 'preview',
        ...(await requireOperation(operations.preview, 'preview').call(operations, {
          text: command.text,
          ...(command.attachments !== undefined ? { attachments: command.attachments } : {}),
        })),
      };
  }
}

function answerResult(answer: AnswerResult): WireCommandResult {
  if (answer.kind === 'accepted') return accepted;
  if (answer.kind === 'stale')
    return { ok: false, code: 'stale_interaction', message: 'Interaction is no longer answerable.' };
  return { ok: false, code: 'rejected', message: 'Interaction resolution was not accepted.' };
}
/** Structured question serialization is not effect authority: the final specific-target
 * resolution still goes through the actual synchronous Session answer operation.
 */
async function answerInteraction(
  session: DirectSession,
  requestId: string,
  decision: WireDecision,
  operations: DirectCommandCapabilities,
  provenance?: WireAnswerProvenance,
): Promise<AnswerResult> {
  if (decision.kind === 'grant')
    return requireOperation(operations.grant, 'scoped approval grants').call(
      operations,
      requestId,
      decision.grant,
      decision.stopAfterApprovalResolution,
      provenance,
    );
  if (decision.kind === 'answers') {
    const capture = session.capture(() => undefined);
    const request = capture.state.pendingInteractions.find((request) => request.requestId === requestId);
    capture.unsubscribe();
    if (!request) return { kind: 'stale' };
    const answer = serializeQuestionAnswers(request, decision.answers);
    return session.answer(
      requestId as InteractionRequestId,
      {
        kind: 'answer',
        answer,
        ...(decision.stopAfterApprovalResolution !== undefined
          ? { stopAfterApprovalResolution: decision.stopAfterApprovalResolution }
          : {}),
      },
      provenance,
    );
  }
  if (decision.kind === 'decline')
    return session.answer(
      requestId as InteractionRequestId,
      {
        kind: 'answer',
        answer: 'User declined to answer.',
        ...(decision.stopAfterApprovalResolution !== undefined
          ? { stopAfterApprovalResolution: decision.stopAfterApprovalResolution }
          : {}),
      },
      provenance,
    );
  return session.answer(requestId as InteractionRequestId, decision, provenance);
}

/** Planner outcomes are effects only after the owning Session has durably accepted them. */
function queueResult(result: DirectQueueMutation): WireCommandResult {
  if (result.kind === 'accepted' || result.kind === 'no_op') return accepted;
  if (result.kind === 'too_late')
    return { ok: false, code: 'too_late', message: 'Queued input is no longer editable or retractable.' };
  return { ok: false, code: 'invalid_command', message: 'Queue mutation was rejected.' };
}

function taskResult(result: DirectTaskControlResult | { readonly ok: true }): WireCommandResult {
  if (result.ok) return accepted;
  return {
    ok: false,
    code: result.code === 'not_found' ? 'not_found' : 'rejected',
    message: `Task control rejected: ${result.code}`,
  };
}
