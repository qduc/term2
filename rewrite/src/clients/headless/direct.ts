/**
 * The direct headless client: one prompt over `DirectConnection`.
 *
 * Command acknowledgement is admission, never completion. The run stays on the
 * ordered event stream until the submitted turn's `turn_ended`, and every
 * failure path states what happened instead of reporting success. It never
 * opens storage, imports Session/Engine, or calls the bridge runtime.
 */
import { randomUUID } from 'node:crypto';
import type { DirectConnection } from '../../host/in-process-direct-types.js';
import type {
  WireAdmission,
  WireCommandResult,
  WireDecision,
  WireEvent,
  WireInteraction,
} from '../../protocol/direct-wire.js';
import { interactionLine, rejectionLine, toolStartLine } from './format.js';
import type {
  DirectHeadlessOptions,
  DirectHeadlessOutcome,
  DirectHeadlessResult,
  HeadlessDecision,
  HeadlessIo,
} from './types.js';

const NON_INTERACTIVE_REJECTION_REASON = 'Non-interactive mode: use --auto-approve to allow tool execution';
/** The old headless CLI's resumable context failures exit 2 rather than 1. */
const RECOVERABLE_ERROR_KINDS = new Set([
  'request_input_limit',
  'context_compaction_hard_fit',
  'provider_context_overflow',
  'context_paused',
]);

/**
 * The conservative headless policy. Without `--auto-approve` every tool
 * approval is denied, with the old reason sent to the model. With it, ordinary
 * tools and low/unknown-risk shell commands are allowed; medium/high-risk shell
 * commands are refused because this client cannot reproduce the old evaluator.
 * A question has no headless answerer, so it is explicitly declined, not guessed.
 */
export function decideHeadlessApproval(interaction: WireInteraction, autoApprove: boolean): HeadlessDecision {
  if (interaction.kind === 'question') {
    return { decision: { kind: 'decline' }, reportRejection: false };
  }
  if (!autoApprove) {
    return { decision: { kind: 'deny', reason: NON_INTERACTIVE_REJECTION_REASON }, reportRejection: false };
  }
  if (interaction.toolName !== 'shell' && interaction.toolName !== 'bash') {
    return { decision: { kind: 'allow' } };
  }
  if (interaction.risk === 'medium' || interaction.risk === 'high') {
    const command = commandText(interaction.input);
    const level = interaction.risk === 'high' ? 'RED (dangerous)' : 'YELLOW (suspicious)';
    return {
      decision: {
        kind: 'deny',
        reason: `Heuristic validation failed: command is ${level} and cannot be executed automatically${
          command ? `: ${command}` : ''
        }`,
      },
      reportRejection: true,
    };
  }
  return { decision: { kind: 'allow' } };
}

function commandText(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const command = (input as Record<string, unknown>)['command'];
  return typeof command === 'string' ? command : '';
}

/** Identity carried by the one cursor-addressable admission/turn-start frame. */
function admissionIdentity(
  admission: WireAdmission,
): { readonly messageId: string; readonly turnId: string | null } | null {
  if (admission.kind === 'rejected') return null;
  if (admission.kind === 'duplicate') return admissionIdentity(admission.original);
  return {
    messageId: admission.messageId,
    turnId: admission.kind === 'started' ? (admission.turnId ?? null) : null,
  };
}

export async function runDirectHeadless(
  connection: DirectConnection,
  options: DirectHeadlessOptions,
): Promise<DirectHeadlessResult> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  const output = options.output ?? 'plain';
  const autoApprove = options.autoApprove ?? false;
  const sessionId = connection.sessionId;
  const requestId = options.requestId ?? `req_${randomUUID()}`;
  const reportedErrors = new Set<string>();
  const answered = new Set<string>();
  let targetTurnId: string | null = null;
  let finalText = '';
  let streamedText = '';
  /** Per-message streamed length, so a completed message writes only its missing suffix. */
  const streamedByMessage = new Map<string, number>();
  let cancelSent = false;
  let abortedBeforeStart = false;

  const json = (record: Readonly<Record<string, unknown>>): void => {
    io.stdout.write(`${JSON.stringify(record)}\n`);
  };

  const errorText = (message: string, code?: string): void => {
    if (output === 'json') {
      json({ type: 'error', error: message, ...(code === undefined ? {} : { code }) });
      return;
    }
    if (reportedErrors.has(message)) return;
    reportedErrors.add(message);
    io.stderr.write(`error ${message}\n`);
  };

  const result = (outcome: DirectHeadlessOutcome, exitCode: number, final = finalText): DirectHeadlessResult => ({
    exitCode,
    outcome,
    finalText: final,
    sessionId,
    turnId: targetTurnId,
  });

  const onAbort = (): void => {
    if (targetTurnId === null) {
      // No turn to cancel yet. Detach and report cancellation; the app's host
      // shutdown owns any queued admission. Never cancel another turn by accident.
      abortedBeforeStart = true;
      connection.close();
      return;
    }
    if (cancelSent) return;
    cancelSent = true;
    void connection.send({ type: 'cancel' }).catch(() => undefined);
  };

  if (options.expectedSessionId !== undefined && options.expectedSessionId !== sessionId) {
    errorText(`Connection is for session ${sessionId}, not the requested ${options.expectedSessionId}.`, 'not_found');
    return result('error', 1);
  }
  if (options.signal?.aborted) return result('cancelled', 1);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (output === 'json') {
    json({ type: 'session_start', ...(options.profileMetadata ?? {}) });
  }

  let iterator: AsyncIterator<WireEvent> | null = null;
  try {
    const decide = async (interaction: WireInteraction): Promise<HeadlessDecision> => {
      if (options.decideApproval) return await options.decideApproval(interaction);
      return decideHeadlessApproval(interaction, autoApprove);
    };

    const answer = async (interaction: WireInteraction): Promise<DirectHeadlessResult | null> => {
      if (answered.has(interaction.requestId)) return null;
      answered.add(interaction.requestId);
      if (output === 'plain') io.stderr.write(interactionLine(interaction));
      let decided: HeadlessDecision;
      try {
        decided = await decide(interaction);
      } catch (error) {
        errorText(error instanceof Error ? error.message : String(error));
        void connection.send({ type: 'cancel' }).catch(() => undefined);
        return result('failed', 1);
      }
      if (decided.reportRejection === true && decided.decision.kind === 'deny') {
        if (output === 'json') {
          json({ type: 'approval_rejected', reason: decided.decision.reason ?? null });
        } else {
          io.stderr.write(rejectionLine(decided.decision.reason));
        }
      }
      const answerFailure = await sendAnswer(interaction.requestId, decided.decision);
      if (answerFailure === null) return null;
      void connection.send({ type: 'cancel' }).catch(() => undefined);
      return result('failed', 1);
    };

    /** Null when the answer was accepted; otherwise the explicit failure message. */
    const sendAnswer = async (requestId: string, decision: WireDecision): Promise<string | null> => {
      try {
        const sent = await connection.send({ type: 'answer', requestId, decision });
        if (sent.ok) return null;
        errorText(sent.message, sent.code);
        return sent.message;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errorText(message);
        return message;
      }
    };

    // A resumed session may already be waiting on approvals. Settle them by the
    // same policy before submitting; a stale answer fails explicitly.
    for (const interaction of connection.snapshot.pendingInteractions) {
      const failure = await answer(interaction);
      if (failure) return failure;
    }

    let submitted: WireCommandResult;
    try {
      submitted = await connection.send({
        type: 'submit',
        requestId,
        text: options.prompt,
        origin: options.origin ?? { kind: 'cli' },
        ...(options.attachments !== undefined ? { attachments: options.attachments } : {}),
        ...(options.delivery !== undefined ? { delivery: options.delivery } : {}),
      });
    } catch (error) {
      errorText(error instanceof Error ? error.message : String(error));
      return result('error', 1);
    }
    if (!submitted.ok) {
      errorText(submitted.message, submitted.code);
      return result('error', 1);
    }
    if (submitted.kind !== 'admitted') {
      errorText(`Unexpected submit result: ${submitted.kind}.`, 'internal_error');
      return result('error', 1);
    }
    const admission: WireAdmission = submitted.admission;
    switch (admission.kind) {
      case 'rejected':
        errorText(`Session refused input: ${admission.reason}`, 'rejected');
        return result('error', 1);
      case 'duplicate':
        errorText('The request was already admitted; this run does not replay an earlier request.', 'request_conflict');
        return result('error', 1);
      case 'started':
        targetTurnId = admission.turnId ?? null;
        break;
      case 'queued':
      case 'steering':
        // Admission is not a start. The matching turn_started names the message.
        break;
    }

    iterator = connection.events[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        if (abortedBeforeStart || options.signal?.aborted) return result('cancelled', 1);
        errorText('Turn ended without a terminal event.');
        return result('failed', 1);
      }
      const event = next.value;
      if (event.sessionId !== sessionId) continue;
      if (output === 'json') json(event);

      if (event.type === 'interaction_opened') {
        const failure = await answer(event.payload.interaction);
        if (failure) return failure;
        continue;
      }

      if (targetTurnId === null) {
        if (event.type === 'turn_started' && event.turnId !== null) {
          const admitted = event.payload.admission ? admissionIdentity(event.payload.admission) : null;
          const ours =
            event.payload.input.some((message) => message.id === admission.messageId) ||
            admitted?.messageId === admission.messageId;
          if (ours) targetTurnId = event.turnId;
          continue;
        }
        if (event.type === 'admission') {
          const admitted = admissionIdentity(event.payload.admission);
          if (admitted?.messageId === admission.messageId) {
            targetTurnId = admitted.turnId ?? event.turnId;
          }
          continue;
        }
        if (event.type === 'error') reportEventError(reportedErrors, io, event.payload.error.message, output);
        continue;
      }

      const forTurn = event.turnId === targetTurnId;
      switch (event.type) {
        case 'text_delta':
          if (!forTurn) break;
          streamedByMessage.set(
            event.payload.messageId,
            (streamedByMessage.get(event.payload.messageId) ?? 0) + event.payload.delta.length,
          );
          streamedText += event.payload.delta;
          if (output === 'plain') io.stdout.write(event.payload.delta);
          break;
        case 'reasoning_delta':
          if (forTurn && options.showReasoning === true) io.stderr.write(event.payload.delta);
          break;
        case 'message': {
          if (!forTurn) break;
          const message = event.payload.message;
          if (message.role !== 'assistant' || message.draft === true) break;
          finalText = message.text;
          const key = event.payload.replacesDraftId ?? message.id;
          const streamed = streamedByMessage.get(key) ?? 0;
          if (output === 'plain' && message.text.length > streamed) {
            io.stdout.write(message.text.slice(streamed));
          }
          streamedByMessage.set(key, Math.max(streamed, message.text.length));
          break;
        }
        case 'tool_started':
          if (forTurn && output === 'plain') io.stderr.write(toolStartLine(event.payload.tool));
          break;
        case 'retrying':
          if (forTurn && output === 'plain') {
            io.stderr.write(
              `[retry] attempt ${event.payload.attempt} in ${event.payload.delayMs}ms: ${event.payload.error.message}\n`,
            );
          }
          break;
        case 'notice':
          if (forTurn && output === 'plain') {
            io.stderr.write(`[${event.payload.kind}] ${event.payload.message}\n`);
          }
          break;
        case 'subagent':
          if (forTurn) renderNested(event.payload.role, event.payload.event, output, io, reportedErrors);
          break;
        case 'error':
          reportEventError(reportedErrors, io, event.payload.error.message, output);
          break;
        case 'turn_ended': {
          if (!forTurn) break;
          const outcome = event.payload.outcome;
          if (outcome === 'completed') {
            const final = finalText || streamedText;
            if (output === 'plain') io.stdout.write('\n');
            else json({ type: 'completed', finalText: final });
            return result('completed', 0, final);
          }
          if (outcome === 'cancelled') return result('cancelled', 1);
          if (outcome === 'interrupted') {
            if (event.payload.error) errorText(event.payload.error.message, event.payload.error.kind);
            else errorText('Turn interrupted.');
            return result('interrupted', 1);
          }
          return fail(event.payload.error?.message ?? 'Turn failed.', event.payload.error?.kind, {
            result,
            errorText,
            io,
            output,
            sessionId,
          });
        }
        default:
          break;
      }
    }
  } catch (error) {
    errorText(error instanceof Error ? error.message : String(error));
    return result('error', 1);
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    if (options.closeConnection !== false) connection.close();
    if (iterator) await iterator.return?.();
  }
}

function reportEventError(reported: Set<string>, io: HeadlessIo, message: string, output: 'plain' | 'json'): void {
  if (output === 'json') {
    io.stdout.write(`${JSON.stringify({ type: 'error', error: message })}\n`);
    return;
  }
  if (reported.has(message)) return;
  reported.add(message);
  io.stderr.write(`error ${message}\n`);
}

/** Failed terminal output and the old exit-2 resumable-context mapping. */
function fail(
  message: string,
  kind: string | undefined,
  context: {
    readonly result: (outcome: DirectHeadlessOutcome, exitCode: number) => DirectHeadlessResult;
    readonly errorText: (message: string, code?: string) => void;
    readonly io: HeadlessIo;
    readonly output: 'plain' | 'json';
    readonly sessionId: string;
  },
): DirectHeadlessResult {
  const recoverable = kind !== undefined && RECOVERABLE_ERROR_KINDS.has(kind);
  if (!recoverable) {
    context.errorText(message, kind);
    return context.result('failed', 1);
  }
  const recovery = `Work is retained. Resume with --resume ${context.sessionId} after reviewing the context limit.`;
  if (context.output === 'json') {
    context.io.stdout.write(
      `${JSON.stringify({
        type: 'context_paused',
        error: message,
        code: kind,
        sessionId: context.sessionId,
        recovery,
      })}\n`,
    );
  } else {
    context.io.stderr.write(`error ${message}\n${recovery}\n`);
  }
  return context.result('failed', 2);
}

/** Nested subagent lines keep the old stderr labels; everything else stays nested. */
function renderNested(
  role: string,
  event: WireEvent,
  output: 'plain' | 'json',
  io: HeadlessIo,
  reported: Set<string>,
): void {
  if (output === 'json') return;
  switch (event.type) {
    case 'tool_started':
      io.stderr.write(`[subagent: ${role}] ${toolStartLine(event.payload.tool).replace(/^\[tool\]\s*/, '')}`);
      break;
    case 'retrying':
      io.stderr.write(
        `[subagent ${role} retry] attempt ${event.payload.attempt} in ${event.payload.delayMs}ms: ${event.payload.error.message}\n`,
      );
      break;
    case 'error':
      reportEventError(reported, io, event.payload.error.message, output);
      break;
    default:
      break;
  }
}
