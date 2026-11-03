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
  WireEvent,
  WireTask,
} from '../../protocol/direct-wire.js';
import { createHeadlessAnswerer } from './direct-approvals.js';
import { createHeadlessOutput } from './direct-output.js';
import type { DirectHeadlessOptions, DirectHeadlessOutcome, DirectHeadlessResult } from './types.js';

export { decideHeadlessApproval } from './direct-approvals.js';

const DEFAULT_BACKGROUND_WAIT_MS = 60 * 60 * 1000;
const MAX_BACKGROUND_WAIT_MS = 24 * 60 * 60 * 1000;
/** Old non-interactive exit 2 terminal causes that are not context pauses. */
const BLOCKED_TERMINAL_CAUSES = new Set(['goal_check_unresolved', 'completion_verification_blocked']);
/** Identity carried by the one cursor-addressable admission/turn-start frame. */
function admissionIdentity(
  admission: WireAdmission,
): { readonly messageId: string; readonly turnId: string | null } | null {
  if (admission.kind === 'rejected') return null;
  if (admission.kind === 'duplicate') return admissionIdentity(admission.original);
  return {
    messageId: admission.messageId,
    turnId: admission.kind === 'started' ? admission.turnId ?? null : null,
  };
}

export async function runDirectHeadless(
  connection: DirectConnection,
  options: DirectHeadlessOptions,
): Promise<DirectHeadlessResult> {
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
  let targetTurnId: string | null = null;
  let lastTurnId: string | null = null;
  let background: { deadline: number; nextDrainAt: number; drainRequestId: string | null } | null = null;
  let wakeBackground: (() => void) | null = null;
  let abortedInBackground = false;
  let backgroundCancelled = false;
  let cancelSent = false;
  let abortedBeforeStart = false;

  const presentation = createHeadlessOutput(options, sessionId);
  const { errorText } = presentation;
  const result = (
    outcome: DirectHeadlessOutcome,
    exitCode: number,
    final = presentation.finalText,
  ): DirectHeadlessResult => ({
    exitCode,
    outcome,
    finalText: final,
    sessionId,
    turnId: lastTurnId ?? targetTurnId,
  });

  /** Headless never answers a run-budget check-in; it exits 2 without a grant. */
  const reportBudgetPause = (evidence?: WireBudgetEvidence): DirectHeadlessResult => {
    presentation.reportBudgetPause(evidence);
    return result('budget_paused', 2);
  };

  const cancelBackgroundWork = (): void => {
    if (backgroundCancelled) return;
    backgroundCancelled = true;
    if (targetTurnId !== null) {
      void connection.send({ type: 'cancel', expectedTurnId: targetTurnId }).catch(() => undefined);
    }
    for (const task of activeTasks()) {
      void connection.send({ type: 'task_control', taskId: task.id, action: 'cancel' }).catch(() => undefined);
    }
  };

  const finish = (): DirectHeadlessResult => result('completed', 0, presentation.finish());

  const failBackground = (message: string): DirectHeadlessResult => {
    cancelBackgroundWork();
    const outstanding = activeTasks();
    const details = outstanding
      .map((task) => `${task.kind ?? 'task'} ${task.name ?? task.label ?? task.id} [${task.id}] (${task.status})`)
      .join(', ');
    errorText(`${message}${details.length > 0 ? ` Outstanding: ${details}` : ''}`);
    return result(abortedInBackground || options.signal?.aborted ? 'cancelled' : 'error', 1);
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
    const answer = createHeadlessAnswerer(connection, options, errorText);

    // A resumed session may already be waiting on approvals. Settle them by the
    // same policy before submitting; a stale answer fails explicitly.
    for (const interaction of connection.snapshot.pendingInteractions) {
      if (!(await answer(interaction))) return result('failed', 1);
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
      // Retain the read until a caller consumes it, even if it resolves while
      // a poll has timed out and a drain command is being awaited.
      pendingNext = iterator!.next();
      return pendingNext;
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
        return failBackground(
          'Background work interrupted; cancellation was requested but task settlement is not confirmed.',
        );
      }
      const now = Date.now();
      const pending = pendingNotices();
      const active = activeTasks();
      if (pending.length === 0 && active.length === 0 && expectedCompletion.size === 0) return finish();
      if (now >= phase.deadline) {
        return failBackground(
          `Background work did not finish within ${backgroundWaitTimeoutMs}ms; cancellation was requested but task settlement is not confirmed.`,
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
            presentation.resetTurn();
          }
          return null;
        }
        if (result.kind === 'empty') {
          // Session is authoritative: notices captured before this drain are no
          // longer deliverable (for example, a closed child question). Do not
          // discard notices that arrived while the request was in flight.
          for (const notice of pending) delivered.add(notice.id);
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
        return failBackground(
          'Background work interrupted; cancellation was requested but task settlement is not confirmed.',
        );
      }
      if (background !== null && targetTurnId === null) {
        const driven = await driveBackground();
        if (driven !== null) {
          if (!('waitMs' in driven)) return driven;
          const waited = await waitEvent(driven.waitMs);
          if (waited.kind === 'timeout') {
            // This wait can end at the next notification-drain poll, before
            // the total deadline. Let the driver check that deadline again.
            continue;
          }
          if (waited.kind === 'wake') {
            return failBackground(
              'Background work interrupted; cancellation was requested but task settlement is not confirmed.',
            );
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
              `Background work did not finish within ${backgroundWaitTimeoutMs}ms; cancellation was requested but task settlement is not confirmed.`,
            );
          }
          const waited = await waitEvent(remaining);
          if (waited.kind === 'timeout') {
            return failBackground(
              `Background work did not finish within ${backgroundWaitTimeoutMs}ms; cancellation was requested but task settlement is not confirmed.`,
            );
          }
          if (waited.kind === 'wake') {
            return failBackground(
              'Background work interrupted; cancellation was requested but task settlement is not confirmed.',
            );
          }
          ready = waited.value;
        } else {
          ready = await nextEvent();
          pendingNext = null;
        }
      }
      const next = ready;
      ready = null;
      if (next.done) {
        if (abortedInBackground || options.signal?.aborted) {
          return failBackground(
            'Background work interrupted; cancellation was requested but task settlement is not confirmed.',
          );
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

      if (event.type === 'goal') {
        presentation.event(event, targetTurnId);
        continue;
      }
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
        if (!(await answer(event.payload.interaction))) return result('failed', 1);
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
          presentation.budgetEvidence(event.payload.request.evidence);
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
        if (event.type === 'error') presentation.event(event, targetTurnId);
        continue;
      }

      presentation.event(event, targetTurnId);
      if (event.type === 'turn_ended' && event.turnId === targetTurnId) {
        if (!presentation.endTurn(event)) return result('error', 1);
        lastTurnId = targetTurnId;
        if (targetTurnId !== null) endedTurns.add(targetTurnId);
        const outcome = event.payload.outcome;
        const terminalCause = event.payload.terminalCause;
        if (background !== null && (abortedInBackground || options.signal?.aborted)) {
          return failBackground(
            'Background work interrupted; cancellation was requested but task settlement is not confirmed.',
          );
        }
        if (outcome !== 'cancelled' && terminalCause !== undefined && BLOCKED_TERMINAL_CAUSES.has(terminalCause)) {
          presentation.blockedNotice(event.payload.notice, terminalCause);
          return result('blocked', 2);
        }
        if (outcome === 'completed') {
          // JSON already took the accepted final window's finalText; plain output
          // preserves its streamed/last-message behavior.
          presentation.completeTurn();
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
        return result(
          ...presentation.failure(event.payload.error?.message ?? 'Turn failed.', event.payload.error?.kind),
        );
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
