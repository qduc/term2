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
  WireBackgroundNotice,
  WireBudgetEvidence,
  WireCommandResult,
  WireDecision,
  WireEvent,
  WireInteraction,
  WireTask,
} from '../../protocol/direct-wire.js';
import { interactionLine, rejectionLine, retryLine, toolStartLine } from './format.js';
import {
  legacyCommandMessages,
  legacyFinalResponse,
  legacyReasoningDelta,
  legacyRequestCostUpdate,
  legacyRetry,
  legacyRunBudget,
  legacyTextDelta,
  legacyToolDispatched,
  legacyToolStarted,
  legacyToolCallStreamingDelta,
} from '../../protocol/direct-json.js';
import type {
  DirectHeadlessOptions,
  DirectHeadlessOutcome,
  DirectHeadlessResult,
  HeadlessDecision,
  HeadlessIo,
} from './types.js';

const NON_INTERACTIVE_REJECTION_REASON = 'Non-interactive mode: use --auto-approve to allow tool execution';
const DEFAULT_BACKGROUND_WAIT_MS = 60 * 60 * 1000;
const MAX_BACKGROUND_WAIT_MS = 24 * 60 * 60 * 1000;
/** The old headless CLI's resumable context failures exit 2 rather than 1. */
/** Old non-interactive exit 2 terminal causes that are not context pauses. */
const BLOCKED_TERMINAL_CAUSES = new Set(['goal_check_unresolved', 'completion_verification_blocked']);
const RECOVERABLE_ERROR_KINDS = new Set([
  'request_input_limit',
  'context_compaction_hard_fit',
  'provider_context_overflow',
  'context_paused',
]);
/** Bounded legacy NDJSON declaration: consumers can see exactly what is exact and
 * what remains unavailable instead of treating the stream as full old parity. */
const LEGACY_JSON_LIVE_RECORDS = [
  'text_delta',
  'reasoning_delta',
  'tool_call_streaming_delta',
  'cost_update',
  'command_message',
  'run_budget',
  'error',
  'tool_started',
  'tool_dispatched',
  'retry',
] as const;
const LEGACY_JSON_UNAVAILABLE = [
  'providerHistory',
  'approval_required',
  'reasoning_started',
  'retry_exhausted',
  'tool_recovery',
  'memory_injected',
  'usage_update',
  'context_compaction_started',
  'context_compaction_completed',
  'context_compaction_failed',
  'background_subagent_events',
] as const;

/**
 * The conservative headless policy. Without `--auto-approve` every tool
 * approval is denied, with the old reason sent to the model. With it, ordinary
 * tools and low/unknown-risk shell commands are allowed; medium/high-risk shell
 * commands are refused because this client cannot reproduce the old evaluator.
 * A question has no headless answerer. The empty answer plus
 * `stopAfterApprovalResolution` is a selected resolution (the source canonical
 * "no answer" result), not a cancellation; it settles that question and
 * suppresses later model work.
 */
export function decideHeadlessApproval(interaction: WireInteraction, autoApprove: boolean): HeadlessDecision {
  if (interaction.kind === 'question') {
    return {
      decision: { kind: 'answer', answer: '', stopAfterApprovalResolution: true },
      reportRejection: false,
    };
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
  const quiet = options.quiet ?? false;
  const sessionId = connection.sessionId;
  const requestedBackgroundWait = options.backgroundWaitTimeoutMs;
  const backgroundWaitTimeoutMs =
    requestedBackgroundWait === undefined || !Number.isFinite(requestedBackgroundWait)
      ? DEFAULT_BACKGROUND_WAIT_MS
      : Math.min(MAX_BACKGROUND_WAIT_MS, Math.max(1, Math.floor(requestedBackgroundWait)));
  const tasks = new Map<string, WireTask>();
  for (const task of connection.snapshot.tasks) tasks.set(task.id, task);
  const notices = new Map<string, WireBackgroundNotice>();
  const delivered = new Set<string>();
  /** A background task fact and its completion notice are one accepted batch; do
   * not finish between the two events if the task frame is observed first.
   */
  const expectedCompletion = new Set<string>();
  const endedTurns = new Set<string>();
  for (const turn of connection.snapshot.turnResults ?? []) endedTurns.add(turn.turnId);
  if (connection.snapshot.terminal !== null) endedTurns.add(connection.snapshot.terminal.turnId);
  for (const notice of connection.snapshot.notifications?.notices ?? []) notices.set(notice.id, notice);
  for (const delivery of connection.snapshot.notifications?.deliveries ?? []) {
    for (const id of delivery.notificationIds) delivered.add(id);
  }

  const activeTasks = (): WireTask[] =>
    [...tasks.values()].filter(
      (task) => task.status === 'running' || task.status === 'awaiting_interaction' || task.status === 'cancelling',
    );
  const pendingNotices = (): WireBackgroundNotice[] =>
    [...notices.values()].filter((notice) => !delivered.has(notice.id));
  const completionNoticeFor = (taskId: string): boolean =>
    [...notices.values()].some((notice) => notice.kind === 'completion' && notice.taskIds.includes(taskId));
  const terminalTask = (status: WireTask['status']): boolean =>
    status === 'completed' || status === 'cancelled' || status === 'failed' || status === 'interrupted';
  const requestId = options.requestId ?? `req_${randomUUID()}`;
  const reportedErrors = new Set<string>();
  const answered = new Set<string>();
  const emittedCommandMessageIds = new Set<string>();
  let targetTurnId: string | null = null;
  let lastTurnId: string | null = null;
  let finalText = '';
  let streamedText = '';
  let completedText = '';
  let background: { deadline: number; nextDrainAt: number; drainRequestId: string | null } | null = null;
  let wakeBackground: (() => void) | null = null;
  let abortedInBackground = false;
  let backgroundCancelled = false;
  /** Per-message streamed length, so a completed message writes only its missing suffix. */
  const streamedByMessage = new Map<string, number>();
  let cancelSent = false;
  let abortedBeforeStart = false;

  const json = (record: unknown): void => {
    io.stdout.write(`${JSON.stringify(record)}\n`);
  };
  if (output === 'json')
    json({
      type: 'session_start',
      ...(options.profileMetadata ?? {}),
      legacyJson: {
        finalWindow: 'public-turn-v1',
        liveRecords: [...LEGACY_JSON_LIVE_RECORDS],
        unavailable: [...LEGACY_JSON_UNAVAILABLE],
      },
    });

  const errorText = (message: string, code?: string): void => {
    if (output === 'json') {
      json({ type: 'error', message, error: message, ...(code === undefined ? {} : { code }) });
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
    turnId: lastTurnId ?? targetTurnId,
  });

  /** Headless never answers a run-budget check-in; it exits 2 without a grant. */
  const reportBudgetPause = (evidence?: WireBudgetEvidence): DirectHeadlessResult => {
    // Session disposal currently closes the pending budget as a system stop.
    // Do not promise an interactive review that does not exist.
    const recovery = `Run budget paused. Work and completed results are retained, but this one-shot run cannot leave the budget request open: exiting closes it as a system stop. Resume with --resume ${sessionId} to inspect the stopped turn; budget review and extension are not available in headless. --auto-approve only approves tools.`;
    if (output === 'json') {
      json({
        type: 'run_budget_paused',
        code: 'run_budget_paused',
        sessionId,
        ...(evidence === undefined ? {} : { evidence }),
        recovery,
      });
    } else {
      io.stderr.write(`${recovery}\n`);
    }
    return result('budget_paused', 2);
  };

  const cancelBackgroundWork = (): void => {
    if (backgroundCancelled) return;
    backgroundCancelled = true;
    if (targetTurnId !== null) {
      void connection.send({ type: 'cancel', expectedTurnId: targetTurnId }).catch(() => undefined);
    }
    for (const task of activeTasks()) {
      void connection
        .send({ type: 'task_control', taskId: task.id, action: 'cancel' })
        .catch(() => undefined);
    }
  };

  const finish = (): DirectHeadlessResult => {
    const final = completedText;
    if (output === 'plain') io.stdout.write('\n');
    else json({ type: 'completed', finalText: final });
    return result('completed', 0, final);
  };

  const failBackground = (message: string): DirectHeadlessResult => {
    cancelBackgroundWork();
    const outstanding = activeTasks();
    const details = outstanding
      .map((task) => `${task.kind ?? 'task'} ${task.name ?? task.label ?? task.id} [${task.id}] (${task.status})`)
      .join(', ');
    errorText(`${message}${details.length > 0 ? ` Outstanding: ${details}` : ''}`);
    return result('error', 1);
  };

  // Old --json records are emitted only from exact native/public data. A missing
  // final window on an old/recovered terminal was already rebuilt read-only from
  // its accepted prefix when one exists; otherwise fail explicitly rather than
  // presenting a partial final/stream as legacy parity.

  const onAbort = (): void => {
    if (background !== null) {
      abortedInBackground = true;
      cancelBackgroundWork();
      wakeBackground?.();
      return;
    }
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
  if (connection.snapshot.pendingBudgets !== undefined && connection.snapshot.pendingBudgets.length > 0) {
    return reportBudgetPause(connection.snapshot.pendingBudgets[0]?.evidence);
  }
  if (options.signal?.aborted) return result('cancelled', 1);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  let iterator: AsyncIterator<WireEvent> | null = null;
  try {
    const decide = async (interaction: WireInteraction): Promise<HeadlessDecision> => {
      if (options.decideApproval) return await options.decideApproval(interaction);
      return decideHeadlessApproval(interaction, autoApprove);
    };

    const answer = async (interaction: WireInteraction): Promise<DirectHeadlessResult | null> => {
      if (answered.has(interaction.requestId)) return null;
      answered.add(interaction.requestId);
      if (output === 'plain' && !quiet) io.stderr.write(interactionLine(interaction));
      let decided: HeadlessDecision;
      try {
        decided = await decide(interaction);
      } catch (error) {
        errorText(error instanceof Error ? error.message : String(error));
        void connection.send({ type: 'cancel' }).catch(() => undefined);
        return result('failed', 1);
      }
      if (decided.reportRejection === true && decided.decision.kind === 'deny') {
        io.stderr.write(rejectionLine(decided.decision.reason));
      }
      const answerFailure = await sendAnswer(interaction.requestId, decided.decision);
      if (answerFailure === null) return null;
      // Cancellation closes pending interactions before the policy answer lands.
      // That stale answer is expected: keep the ordered stream and let the real
      // terminal (cancelled) decide, rather than reporting a failure.
      if (options.signal?.aborted && answerFailure.code === 'stale_interaction') return null;
      void connection.send({ type: 'cancel' }).catch(() => undefined);
      return result('failed', 1);
    };

    /** Null when the answer was accepted; otherwise the protocol failure. */
    const sendAnswer = async (
      requestId: string,
      decision: WireDecision,
    ): Promise<{ readonly code: string; readonly message: string } | null> => {
      try {
        const sent = await connection.send({ type: 'answer', requestId, decision });
        if (sent.ok) return null;
        errorText(sent.message, sent.code);
        return { code: sent.code, message: sent.message };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errorText(message);
        return { code: 'internal_error', message };
      }
    };

    // A resumed session may already be waiting on approvals. Settle them by the
    // same policy before submitting; a stale answer fails explicitly.
    for (const interaction of connection.snapshot.pendingInteractions) {
      const failure = await answer(interaction);
      if (failure) return failure;
    }
    if (options.signal?.aborted) return result('cancelled', 1);

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
    let pendingNext: Promise<IteratorResult<WireEvent>> | null = null;
    const nextEvent = (): Promise<IteratorResult<WireEvent>> => {
      if (pendingNext !== null) return pendingNext;
      const pending = iterator!.next();
      pendingNext = pending;
      void pending.catch(() => {
        if (pendingNext === pending) pendingNext = null;
      });
      return pending;
    };
    // Every race arm has the same discriminator; a wake/timeout is not an iterator item.
    const waitEvent = async (
      ms: number,
    ): Promise<
      | { readonly kind: 'event'; readonly value: IteratorResult<WireEvent> }
      | { readonly kind: 'timeout' }
      | { readonly kind: 'wake' }
    > => {
      if (ms <= 0) return { kind: 'timeout' };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake!: () => void;
      const wakePromise = new Promise<{ readonly kind: 'wake' }>((resolve) => {
        wake = () => resolve({ kind: 'wake' });
      });
      wakeBackground = wake;
      try {
        const waited = await Promise.race([
          nextEvent().then((value) => ({ kind: 'event' as const, value })),
          new Promise<{ readonly kind: 'timeout' }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
          }),
          wakePromise,
        ]);
        if (waited.kind === 'event') pendingNext = null;
        return waited;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        wakeBackground = null;
      }
    };

    /** Drain real notice batches and wait for all background work, as old headless did. */
    const driveBackground = async (): Promise<DirectHeadlessResult | { readonly waitMs: number } | null> => {
      const phase = background;
      if (phase === null || targetTurnId !== null) return null;
      if (abortedInBackground || options.signal?.aborted) {
        return failBackground('Background work interrupted; unfinished work was cancelled.');
      }
      const now = Date.now();
      const pending = pendingNotices();
      const active = activeTasks();
      if (pending.length === 0 && active.length === 0 && expectedCompletion.size === 0) return finish();
      if (now >= phase.deadline) {
        return failBackground(
          `Background work did not finish within ${backgroundWaitTimeoutMs}ms; unfinished work was cancelled.`,
        );
      }
      if (pending.length > 0 && now >= phase.nextDrainAt) {
        const drainRequestId = phase.drainRequestId ?? `drain_${randomUUID()}`;
        phase.drainRequestId = drainRequestId;
        let drained: WireCommandResult;
        try {
          drained = await connection.send({ type: 'drain_background_notifications', requestId: drainRequestId });
        } catch (error) {
          return failBackground(
            `Background notification drain failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!drained.ok) {
          return failBackground(`Background notification drain was not admitted: ${drained.message}`);
        }
        if (drained.kind !== 'background_drain') {
          return failBackground(`Unexpected background drain result: ${drained.kind}.`);
        }
        const result = drained.result;
        if (result.kind === 'started' || result.kind === 'duplicate') {
          phase.drainRequestId = null;
          phase.nextDrainAt = 0;
          if (!endedTurns.has(result.turnId)) {
            targetTurnId = result.turnId;
            lastTurnId = result.turnId;
            finalText = '';
            streamedText = '';
            streamedByMessage.clear();
          }
          return null;
        }
        phase.drainRequestId = null;
        phase.nextDrainAt = Date.now() + 100;
      }
      const remaining = phase.deadline - Date.now();
      const untilDrain = phase.nextDrainAt - Date.now();
      return { waitMs: Math.max(0, Math.min(remaining, pending.length > 0 ? untilDrain : remaining)) };
    };

    let ready: IteratorResult<WireEvent> | null = null;
    for (;;) {
      if (background !== null && (abortedInBackground || options.signal?.aborted)) {
        return failBackground('Background work interrupted; unfinished work was cancelled.');
      }
      if (background !== null && targetTurnId === null) {
        const driven = await driveBackground();
        if (driven !== null) {
          if (!('waitMs' in driven)) return driven;
          const waited = await waitEvent(driven.waitMs);
          if (waited.kind === 'timeout') {
            return failBackground(
              `Background work did not finish within ${backgroundWaitTimeoutMs}ms; unfinished work was cancelled.`,
            );
          }
          if (waited.kind === 'wake') {
            return failBackground('Background work interrupted; unfinished work was cancelled.');
          }
          ready = waited.value;
        } else {
          continue;
        }
      }
      if (ready === null) {
        if (background !== null) {
          const remaining = background.deadline - Date.now();
          if (remaining <= 0) {
            return failBackground(
              `Background work did not finish within ${backgroundWaitTimeoutMs}ms; unfinished work was cancelled.`,
            );
          }
          const waited = await waitEvent(remaining);
          if (waited.kind === 'timeout') {
            return failBackground(
              `Background work did not finish within ${backgroundWaitTimeoutMs}ms; unfinished work was cancelled.`,
            );
          }
          if (waited.kind === 'wake') {
            return failBackground('Background work interrupted; unfinished work was cancelled.');
          }
          ready = waited.value;
        } else {
          ready = await nextEvent();
        }
      }
      const next = ready;
      ready = null;
      if (next.done) {
        if (abortedInBackground || options.signal?.aborted) {
          return failBackground('Background work interrupted; unfinished work was cancelled.');
        }
        if (background !== null) {
          if (pendingNotices().length === 0 && activeTasks().length === 0 && expectedCompletion.size === 0)
            return finish();
          return failBackground('Connection ended before background work settled.');
        }
        if (abortedBeforeStart || options.signal?.aborted) return result('cancelled', 1);
        errorText('Turn ended without a terminal event.');
        return result('failed', 1);
      }
      const event = next.value;
      if (event.sessionId !== sessionId) continue;

      if (event.type === 'background_notice_enqueued') {
        const notice = event.payload.notice;
        notices.set(notice.id, notice);
        if (notice.kind === 'completion') {
          for (const taskId of notice.taskIds) expectedCompletion.delete(taskId);
        }
        continue;
      }
      if (event.type === 'background_notices_delivered') {
        for (const id of event.payload.notificationIds) delivered.add(id);
        continue;
      }
      if (event.type === 'interaction_opened') {
        const failure = await answer(event.payload.interaction);
        if (failure) return failure;
        continue;
      }
      if (event.type === 'task_changed') {
        const task = event.payload.task;
        const previous = tasks.get(task.id);
        tasks.set(task.id, task);
        if (
          task.mode === 'background' &&
          terminalTask(task.status) &&
          previous?.status !== task.status &&
          !completionNoticeFor(task.id)
        ) {
          expectedCompletion.add(task.id);
        }
        continue;
      }
      if (event.type === 'budget_opened') {
        if (targetTurnId === null || event.payload.request.turnId === targetTurnId) {
          if (output === 'json') json(legacyRunBudget(event.payload.request.evidence));
          return reportBudgetPause(event.payload.request.evidence);
        }
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
        if (event.type === 'error') reportEventError(reportedErrors, io, event.payload.error.message, output, event.payload.error.kind);
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
          else json(legacyTextDelta(event));
          break;
        case 'reasoning_delta':
          if (!forTurn) break;
          if (output === 'json') json(legacyReasoningDelta(event));
          else if (options.showReasoning === true) io.stderr.write(event.payload.delta);
          break;
        case 'tool_call_streaming_delta':
          if (forTurn && output === 'json') json(legacyToolCallStreamingDelta(event));
          break;
        case 'request_cost_recorded':
          if (
            output === 'json' &&
            (event.payload.turnId === targetTurnId || event.payload.rootTurnId === targetTurnId)
          )
            json(legacyRequestCostUpdate(event));
          break;
        case 'tool_finished':
          if (!forTurn || output !== 'json') break;
          for (const message of legacyCommandMessages(event)) {
            emittedCommandMessageIds.add(message.message.id);
            json(message);
          }
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
        case 'tool_called':
          if (forTurn && output === 'json') {
            const record = legacyToolStarted(event);
            if (record !== undefined) json(record);
          }
          break;
        case 'tool_started':
          if (forTurn && output === 'plain' && !quiet) io.stderr.write(toolStartLine(event.payload.tool));
          if (forTurn && output === 'json') {
            const record = legacyToolDispatched(event);
            if (record !== undefined) json(record);
          }
          break;
        case 'retrying':
          if (forTurn && output === 'plain' && !quiet) io.stderr.write(retryLine(event.payload));
          if (forTurn && output === 'json') {
            const record = legacyRetry(event);
            if (record !== undefined) json(record);
          }
          break;
        case 'budget_observed':
          if (forTurn && output === 'json') json(legacyRunBudget(event.payload.evidence));
          break;
        case 'notice':
          if (forTurn && output === 'plain' && !quiet) {
            io.stderr.write(`[${event.payload.kind}] ${event.payload.message}\n`);
          }
          break;
        case 'subagent':
          if (forTurn) {
            renderNested(event.payload.agentId, event.payload.role, event.payload.event, output, io, reportedErrors, quiet);
          }
          break;
        case 'error':
          reportEventError(reportedErrors, io, event.payload.error.message, output, event.payload.error.kind);
          break;
        case 'turn_ended': {
          if (!forTurn) break;
          if (output === 'json') {
            const window = event.payload.finalWindow;
            if (window === undefined) {
              json({
                type: 'error',
                code: 'legacy_final_window_unavailable',
                message: 'Accepted terminal has no final window; refusing to emit a partial legacy --json final.',
                error: 'Accepted terminal has no final window; refusing to emit a partial legacy --json final.',
              });
              return result('error', 1);
            }
            const finalRecord = legacyFinalResponse(window, emittedCommandMessageIds);
            json(finalRecord);
            if (event.payload.outcome === 'completed') completedText = finalRecord.finalText;
          }
          lastTurnId = targetTurnId;
          if (targetTurnId !== null) endedTurns.add(targetTurnId);
          const outcome = event.payload.outcome;
          const terminalCause = event.payload.terminalCause;
          if (background !== null && (abortedInBackground || options.signal?.aborted)) {
            return failBackground('Background work interrupted; unfinished work was cancelled.');
          }
          if (outcome !== 'cancelled' && terminalCause !== undefined && BLOCKED_TERMINAL_CAUSES.has(terminalCause)) {
            if (event.payload.notice !== undefined) io.stderr.write(`${event.payload.notice}\n`);
            return result('blocked', 2);
          }
          if (outcome === 'completed') {
            // JSON already took the accepted final window's finalText; plain output
            // preserves its streamed/last-message behavior.
            if (output !== 'json') completedText = finalText || streamedText || completedText;
            if (background === null) {
              background = { deadline: Date.now() + backgroundWaitTimeoutMs, nextDrainAt: 0, drainRequestId: null };
              targetTurnId = null;
              continue;
            }
            targetTurnId = null;
            background.nextDrainAt = 0;
            background.drainRequestId = null;
            continue;
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

function reportEventError(
  reported: Set<string>,
  io: HeadlessIo,
  message: string,
  output: 'plain' | 'json',
  kind?: string,
): void {
  if (output === 'json') {
    io.stdout.write(`${JSON.stringify({ type: 'error', message, error: message, ...(kind === undefined ? {} : { kind }) })}\n`);
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
  return context.result('context_paused', 2);
}

/** Nested subagent lines keep the old stderr labels; everything else stays nested. */
function renderNested(
  agentId: string,
  role: string | undefined,
  event: WireEvent,
  output: 'plain' | 'json',
  io: HeadlessIo,
  reported: Set<string>,
  quiet: boolean,
): void {
  if (output === 'json' || quiet) return;
  const label = role === undefined ? '[subagent]' : `[subagent: ${role}]`;
  switch (event.type) {
    case 'tool_started':
      io.stderr.write(`${label} ${toolStartLine(event.payload.tool).replace(/^\[tool\]\s*/, '')}`);
      break;
    case 'retrying':
      io.stderr.write(retryLine(event.payload, agentId));
      break;
    case 'error':
      reportEventError(reported, io, event.payload.error.message, output);
      break;
    default:
      break;
  }
}
