/**
 * The direct conversation owns the engine reader and the durable writer. An
 * engine envelope is accepted only after its fact has committed. Public events
 * contain no acceptance capability; answers likewise commit before release.
 * Cancellation/consumer return retains turn ownership through physical cleanup.
 */
import { startTurn, startCompaction } from '../engine/index.js';
import type {
  AcceptedTurnEvent,
  InteractionDecision,
  InteractionRequest,
  InteractionRequestId,
  TurnEvent,
  TurnHandle,
  TurnId,
  TurnDeps,
  TurnResult,
} from '../engine/index.js';
import { DirectBackgroundCheckIns } from './direct-background-check-ins.js';
import {
  directCheckInNotice,
  directTaskNotice,
  isDirectNotificationFactType,
  pendingDirectNotifications,
  reduceDirectNotifications,
  type DirectNotificationFact,
  type DirectNotificationState,
} from './direct-notifications.js';
import { parseDirectConfigurationFact, type DirectPreparedConfiguration } from './direct-configuration.js';
import { directRolloverAtBoundary } from './direct-rollover.js';
import { parseDirectSessionRotation } from './direct-session-rotation.js';
import { captureDirectFinalWindow } from './direct-final.js';
import { captureDirectCommandHistory } from './direct-history-capture.js';
import { listDirectRewindTargets, planDirectHistoryCommand } from './direct-command-history.js';
import {
  isDirectCommandFactType,
  planDirectCommandStart,
  planDirectCommandFinish,
  reduceDirectCommandReceipts,
  recoverDirectCommands,
} from './direct-command-receipts.js';
import type {
  DirectCommandFact,
  DirectCommandReceipts,
  DirectCommandOutcome,
  DirectCommandResult,
} from './direct-command-types.js';
import { parseDirectOrigin, isDirectHumanOrigin } from './direct-origin.js';
import { DirectSubagents } from './direct-subagent.js';
import { DirectContinuity, type DirectContinuityBinding } from '../engine/direct-recovery-continuity.js';
import { directPreviewConfiguration, directPreviewOccurrences } from './direct-preview.js';
import { DirectRunBudgets } from './direct-run-budget.js';
import { createDirectBranchDriver } from './direct-branches.js';
import type { BudgetDecision } from '../engine/direct-types.js';
import { randomUUID } from 'node:crypto';
import type {
  DirectQueueState,
  DirectQueuePlan,
  DirectQueueEffect,
  DirectQueueCommand,
  DirectQueueSubmission,
} from './direct-queue-types.js';
import type { DirectBackgroundTasks as BackgroundTasksType } from './direct-background.js';
import { DirectBackgroundTasks } from './direct-background.js';
import { recoverDirectBackground, reduceDirectBackground } from './direct-background-replay.js';
import type { DirectTaskState } from './direct-background-types.js';
import { createDirectQueueState, reduceDirectQueue, submitDirectQueue, planDirectQueue } from './direct-queue.js';
import { initialDirectContextState, reduceDirectContext, type DirectContextFact } from './direct-context.js';
import { bindDirectCapabilities } from './direct-capabilities.js';
import { isDirectTaskFact, isDirectQueueFact } from './facts.js';
import type { DirectOrigin } from './facade-types.js';
import type { Item, ModelError, ModelRequest } from '../model/index.js';
import type {
  AnswerResult,
  AnswerProvenance,
  Conversation,
  ConversationDeps,
  Turn,
  TurnRequest,
  StartedConversationTurn,
} from './direct-types.js';
import type { Fact, FactLine, DirectTurnFact, DirectHistoryFact, SessionStartedFact } from './facts.js';
import { replay } from './replay.js';

export type { AnswerResult, Conversation, ConversationDeps, Turn, TurnRequest } from './direct-types.js';

/** Writes session_started before any engine can be constructed. */
export function createConversation(
  deps: ConversationDeps & { readonly meta: Omit<SessionStartedFact, 'type'> },
): Conversation {
  const started: Fact = { type: 'session_started', ...deps.meta };
  const entries = deps.log.append([started]);
  return conversation(deps, deps.meta.id, [started], entries);
}

/** Opening is read-only; recovery is materialized with the next turn's input. */
export function openConversation(deps: ConversationDeps & { readonly facts: readonly Fact[] }): Conversation {
  const started = deps.facts.find((fact) => fact.type === 'session_started');
  if (!started) throw new Error(`${deps.log.path} has no session_started fact`);
  // Reject inconsistent histories before a later run can write to them.
  replay(deps.facts);
  return conversation(deps, started.id, [...deps.facts]);
}

function conversation(
  deps: ConversationDeps,
  id: string,
  facts: Fact[],
  newEntries: readonly FactLine[] = [],
): Conversation {
  let active: (Turn & { readonly turnId: TurnId; readonly cancelled: boolean; stop(): Promise<void> }) | null = null;
  let runtimeDeps = deps;
  let configuredRequest: Omit<TurnRequest, 'input' | 'submission'> | undefined;
  let pendingProfileNotice: string | undefined;
  let continuity = deps.continuity
    ? { ...deps.continuity, state: deps.continuity.state ?? new DirectContinuity() }
    : undefined;
  let commandReceipts: DirectCommandReceipts = [];
  let historyRevision = 0;
  let notifications: DirectNotificationState = { notices: [], deliveries: [] };
  let commandOwner: {
    readonly commandId: string;
    readonly kind: import('./direct-command-types.js').DirectCommandOperation['kind'];
    readonly abort: AbortController;
    done?: Promise<unknown>;
  } | null = null;
  const rolloverDestination = (): string | undefined => {
    for (const receipt of commandReceipts) {
      if (receipt.outcome?.kind === 'rolled_over' && receipt.outcome.sessionId !== id) return receipt.outcome.sessionId;
    }
    return undefined;
  };
  let context = initialDirectContextState();
  let queueState: DirectQueueState = createDirectQueueState();
  let taskStates: readonly DirectTaskState[] = [];
  const requestIds = new Set<InteractionRequestId>();
  for (const fact of facts) {
    if (isDirectCommandFactType(fact.type))
      commandReceipts = reduceDirectCommandReceipts(commandReceipts, fact as DirectCommandFact);
    if (isDirectNotificationFactType(fact.type))
      notifications = reduceDirectNotifications(notifications, fact as DirectNotificationFact);
    if (changesRootHistory(fact)) ++historyRevision;
    context = reduceDirectContext(context, fact, queueState.records);
    if (isDirectQueueFact(fact)) queueState = reduceDirectQueue(queueState, fact);
    if (isDirectTaskFact(fact)) taskStates = reduceDirectBackground(taskStates, fact);
    if (fact.type === 'interaction_opened' || fact.type === 'task_interaction_opened')
      requestIds.add(fact.request.requestId);
  }
  let nextTurnId = Math.max(
    1,
    ...facts.flatMap((fact) => {
      const candidates = [
        'turnId' in fact ? fact.turnId : undefined,
        fact.type === 'queue_submitted' ? fact.record.admission.turnId : undefined,
      ];
      return candidates.flatMap((value) => {
        const match = value?.match(/^turn-(\d+)$/);
        return match ? [Number(match[1]) + 1] : [];
      });
    }),
  );
  let queueSettings: Omit<TurnRequest, 'input' | 'submission'> | undefined;
  let recoveryMaterialized = false;
  let completionHeld: TurnId | null = null;
  const branchHandles = new Set<TurnHandle>();
  const runBudgets = new DirectRunBudgets(
    deps.budget,
    (fact) => {
      if (!commit([fact])) throw new Error(logFailure!.message);
    },
    facts,
  );
  let tasks: BackgroundTasksType | undefined;
  let capabilities: ReturnType<typeof bindDirectCapabilities> | undefined;
  let hookStatus: 'idle' | 'working' | 'waiting_for_user' | 'waiting_for_approval' = 'idle';
  let closed = false;
  let logFailure: ModelError | null = null;

  const poison = (error: unknown): void => {
    if (logFailure) return;
    logFailure = modelError(error);
    tasks?.poison(logFailure);
    active?.cancel();
    commandOwner?.abort.abort();
    for (const handle of branchHandles) handle.cancel();
  };
  // Projection validation is synchronous and precedes disk mutation. Nothing
  // awaits/reenters between generation CAS, candidate reduction and append.
  const commit = (next: readonly Fact[]): boolean => {
    if (logFailure) return false;
    if (next.length === 0) return true;
    let projectedNotices = notifications;
    let projectedReceipts = commandReceipts;
    let projectedContext = context;
    let projectedQueue = queueState;
    let projectedTasks = taskStates;
    const reserved = new Set(requestIds);
    for (const fact of next) {
      if (isDirectNotificationFactType(fact.type))
        projectedNotices = reduceDirectNotifications(projectedNotices, fact as DirectNotificationFact);
      if (isDirectCommandFactType(fact.type))
        projectedReceipts = reduceDirectCommandReceipts(projectedReceipts, fact as DirectCommandFact);
      projectedContext = reduceDirectContext(projectedContext, fact, projectedQueue.records);
      if (isDirectQueueFact(fact)) projectedQueue = reduceDirectQueue(projectedQueue, fact);
      if (isDirectTaskFact(fact)) projectedTasks = reduceDirectBackground(projectedTasks, fact);
      if (fact.type === 'interaction_opened' || fact.type === 'task_interaction_opened') {
        if (reserved.has(fact.request.requestId)) throw new Error('Duplicate Session interaction request ID');
        reserved.add(fact.request.requestId);
      }
    }
    let lines: readonly FactLine[];
    try {
      lines = deps.log.append(next);
    } catch (error) {
      poison(error);
      return false;
    }
    notifications = projectedNotices;
    commandReceipts = projectedReceipts;
    historyRevision += next.filter(changesRootHistory).length;
    context = projectedContext;
    queueState = projectedQueue;
    taskStates = projectedTasks;
    for (const requestId of reserved) requestIds.add(requestId);
    facts.push(...next);
    for (const line of lines) capabilities?.accepted(line);
    let root: TurnId | undefined;
    const waits = new Map<string, 'approval' | 'question' | 'budget'>();
    for (const fact of facts) {
      if (fact.type === 'turn_started') {
        root = fact.turnId;
        waits.clear();
      }
      if (fact.type === 'interaction_opened' && fact.turnId === root)
        waits.set(fact.request.requestId, fact.request.kind);
      if (fact.type === 'budget_opened' && fact.turnId === root) waits.set(fact.requestId, 'budget');
      if (fact.type === 'interaction_closed' || fact.type === 'budget_closed') waits.delete(fact.requestId);
      if (fact.type === 'turn_ended' && fact.turnId === root) {
        root = undefined;
        waits.clear();
      }
    }
    const current = waits.size
      ? [...waits.values()].some((kind) => kind === 'approval')
        ? 'waiting_for_approval'
        : 'waiting_for_user'
      : root
      ? 'working'
      : 'idle';
    if (current !== hookStatus) {
      capabilities?.status(
        hookStatus,
        current,
        current === 'idle' ? 'turn_finished' : waits.size ? 'approval_requested' : 'turn_started',
        root,
      );
      hookStatus = current;
    }

    return true;
  };
  const liveReplay = () => replay(facts, { recoverQueue: false });
  const recover = (): boolean => {
    if (recoveryMaterialized) return !logFailure;
    const recovered = replay(facts);
    const taskRecovery = recoverDirectBackground(facts.filter(isDirectTaskFact), Date.now());
    if (!commit([...recovered.recoveryFacts, ...taskRecovery, ...recoverDirectCommands(commandReceipts)])) return false;
    recoveryMaterialized = true;
    return true;
  };
  tasks = new DirectBackgroundTasks({
    sessionId: id,
    sink: {
      accept(fact) {
        const taskId =
          fact.type === 'task_started'
            ? fact.task.taskId
            : fact.type === 'task_interaction_opened'
            ? fact.request.taskId
            : fact.taskId;
        const previous = taskStates.find((task) => task.taskId === taskId);
        const notice =
          previous &&
          !closed &&
          (fact.type === 'task_backgrounded'
            ? directTaskNotice(previous, 'background')
            : fact.type === 'task_stop_requested'
            ? directTaskNotice(previous, 'stop')
            : fact.type === 'task_finished' && previous.mode === 'background'
            ? directTaskNotice(previous, 'finished', fact.result)
            : undefined);
        if (
          (closed && (fact.type === 'task_started' || fact.type === 'task_interaction_opened')) ||
          !recover() ||
          !commit([fact, ...(notice ? [{ type: 'background_notice_enqueued' as const, notice }] : [])])
        )
          throw new Error(logFailure?.message ?? 'Session is closed');
      },
      publish: (event) => deps.publishTask?.(event),
      failed: poison,
    },
  });
  let checkInSettings: (() => import('./direct-background-check-ins.js').DirectBackgroundCheckInSettings) | undefined;
  const checkIns = new DirectBackgroundCheckIns({
    tasks,
    settings: () => checkInSettings?.() ?? { enabled: false, intervalMs: 1 },
    emit(event) {
      if (closed || logFailure) return;
      if (!commit([{ type: 'background_notice_enqueued', notice: directCheckInNotice(event) }]))
        throw new Error(logFailure!.message);
    },
  });
  const configureTaskCheckIn: Conversation['configureTaskCheckIn'] = (target, policy) =>
    closed || logFailure ? { ok: false, code: 'not_active' } : checkIns.configure(target, policy);
  const contextCommit = (generation: number, next: readonly DirectContextFact[], turnId?: TurnId): boolean => {
    if (
      closed ||
      logFailure ||
      context.goal.generation !== generation ||
      (turnId !== undefined && (!active || active.turnId !== turnId || active.cancelled))
    )
      return false;
    try {
      return commit(next);
    } catch {
      return false;
    }
  };
  let supplied = deps.context?.({
    sessionId: id,
    get backingSessionId() {
      return deps.rotationBoundary?.().sessionId ?? id;
    },
    read: () => structuredClone(context),
    commit: (generation, next) => contextCommit(generation, next),
    tasks,
    configureTaskCheckIn,
  });
  checkInSettings = supplied?.backgroundCheckIns;
  const checkInTimer = checkInSettings
    ? setInterval(() => {
        try {
          checkIns.tick();
        } catch (error) {
          poison(error);
        }
      }, 30_000)
    : undefined;
  checkInTimer?.unref();
  capabilities = bindDirectCapabilities({
    sessionId: id,
    read: () => context,
    facts: () => facts,
    commit: contextCommit,
    validTurn: (turnId) => !!active && active.turnId === turnId && !active.cancelled && !closed && !logFailure,
    baseTools: deps.tools,
    capabilities: supplied,
    canRollover: () => !!runtimeDeps.rollover,
    requestRollover(turnId, request) {
      if (
        !runtimeDeps.rollover ||
        !active ||
        active.turnId !== turnId ||
        active.cancelled ||
        commandOwner ||
        closed ||
        logFailure
      )
        return { ok: false, status: 'rollover_blocked', error: 'This root no longer has rollover authority.' };
      const existing = facts.find((fact) => fact.type === 'rollover_requested' && fact.turnId === turnId);
      if (existing?.type === 'rollover_requested') {
        if (existing.request.brief !== request.brief || existing.request.reason !== request.reason)
          return { ok: false, status: 'rollover_blocked', error: 'This root already accepted a different handoff.' };
        return { ok: true, status: 'rollover_requested', rolloverId: existing.commandId };
      }
      const commandId = `rollover:${randomUUID()}`;
      if (
        !contextCommit(
          context.goal.generation,
          [{ type: 'rollover_requested', turnId, commandId, request: structuredClone(request) }],
          turnId,
        )
      )
        return { ok: false, status: 'rollover_blocked', error: logFailure?.message ?? 'The handoff was not accepted.' };
      completionHeld = turnId;
      return { ok: true, status: 'rollover_requested', rolloverId: commandId };
    },
  });
  for (const entry of newEntries) capabilities.accepted(entry);
  const environment = () => ({
    newMessageId: randomUUID,
    newTurnId: () => `turn-${nextTurnId++}` as TurnId,
    now: () => new Date().toISOString(),
    dispatchHeld: !!active || !!completionHeld || !!commandOwner || closed || !!logFailure,
  });
  const boundary = (turnId: TurnId): readonly Item[] => {
    if (!active || active.turnId !== turnId || active.cancelled || commandOwner || closed || logFailure) return [];
    const plan = planDirectQueue(queueState, { kind: 'boundary', turnId }, environment());
    if (!commit(plan.facts)) throw new Error(logFailure!.message);
    return plan.effect?.kind === 'steer' ? plan.effect.modelInput : [];
  };

  function ownTurn(
    turnId: TurnId,
    handle: TurnHandle,
  ): Turn & { readonly turnId: TurnId; readonly cancelled: boolean; stop(): Promise<void> } {
    const requests = new Map<InteractionRequestId, InteractionRequest>();
    const budgets = new Map<InteractionRequestId, Extract<TurnEvent, { type: 'budget_required' }>>();
    const engine = handle.events[Symbol.asyncIterator]();
    let cancelled = false;
    let started = false;
    let done = false;
    let released = false;
    let terminal: TurnResult | null = null;
    let streamFailure: ModelError | null = null;

    const closeInteractions = (): void => {
      const closures: Fact[] = [...requests.keys()].map((requestId) => ({
        type: 'interaction_closed',
        turnId,
        requestId,
        resolution: { kind: 'cancelled' },
      }));
      requests.clear();
      for (const requestId of budgets.keys())
        closures.push({ type: 'budget_closed', turnId, requestId, decision: { kind: 'stop' }, source: 'system' });
      budgets.clear();
      commit(closures);
    };
    const cancel = (): void => {
      if (released || cancelled) return;
      cancelled = true;
      closeInteractions();
      handle.cancel();
    };
    const settle = (result: TurnResult): void => {
      if (terminal) return;
      closeInteractions();
      const outcome = streamFailure
        ? { kind: 'failed' as const, error: streamFailure }
        : cancelled && result.kind === 'completed'
        ? { kind: 'cancelled' as const }
        : result;
      if (!logFailure) {
        // The same deterministic repair used on reopen supplies missing root
        // results. Its interrupted terminal is replaced by the actual outcome.
        const repairs = liveReplay().recoveryFacts.filter((fact) => fact.type !== 'turn_ended');
        const ended = terminalFact(turnId, outcome);
        commit([...repairs, { ...ended, finalWindow: captureDirectFinalWindow([...facts, ...repairs], ended) }]);
      }
      terminal = logFailure ? { kind: 'failed', error: logFailure } : outcome;
    };
    const consume = ({ token, event }: AcceptedTurnEvent, draining: boolean): TurnEvent | null => {
      if (event.type === 'turn_ended') {
        settle(event.result);
        if (logFailure) handle.cancel();
        else handle.accept(token);
        return null;
      }
      if (terminal || logFailure) return null;
      // Cleanup outcomes still matter, but late text/progress and unadmitted
      // starts must not become visible or authorize work after cancellation.
      const cleanup =
        event.type === 'tool_execution_finished' ||
        event.type === 'compaction_completed' ||
        event.type === 'compaction_failed' ||
        (event.type === 'item' && event.item.type === 'tool_result');
      if ((cancelled || draining) && !cleanup) return null;
      const fact = factFor(turnId, event);
      if (fact && !commit([fact])) {
        cancel();
        return null;
      }
      if (event.type === 'budget_required') budgets.set(event.requestId, event);
      if (event.type === 'interaction_required') requests.set(event.request.requestId, event.request);
      handle.accept(token);
      return cancelled || draining ? null : event;
    };
    const drain = async (): Promise<void> => {
      while (!done) {
        try {
          const next = await engine.next();
          done = next.done === true;
          if (!next.done) consume(next.value, true);
        } catch (error) {
          done = true;
          streamFailure ??= modelError(error);
        }
      }
      if (!terminal) settle(streamFailure ? { kind: 'failed', error: streamFailure } : lostTerminal);
    };

    async function* drive(): AsyncGenerator<TurnEvent, void> {
      started = true;
      try {
        while (!done) {
          const next = await engine.next();
          done = next.done === true;
          if (next.done) break;
          const event = consume(next.value, false);
          if (event) yield event;
        }
      } catch (error) {
        streamFailure = modelError(error);
      } finally {
        // Do not use for-await's implicit iterator.return: the engine may have
        // outstanding bodies whose finish events must be consumed first.
        if (!done) cancel();
        try {
          await drain();
          if (!cancelled && !logFailure && capabilities?.finalizeHuman) {
            const admission = facts.find((fact) => fact.type === 'turn_started' && fact.turnId === turnId);
            if (
              admission?.type === 'turn_started' &&
              !admission.silent &&
              !admission.maintenance &&
              !admission.retryContext &&
              isDirectHumanOrigin(admission.submission?.origin)
            ) {
              const content = admission.input.flatMap((item) =>
                item.type === 'user_message' ? [...item.content] : [],
              );
              const notice = await capabilities.finalizeHuman({
                admissionId: admission.submission?.messageId ?? turnId,
                text: content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
                images: content.filter((part) => part.type === 'image'),
              });
              if (notice) deps.publishNotice?.(notice);
            }
          }
        } finally {
          released = true;
          if (active?.turnId === turnId) active = null;
        }
      }
      yield { type: 'turn_ended', result: terminal! };
    }
    const stream = drive();
    const stop = async (): Promise<void> => {
      cancel();
      // Returning a never-started async generator skips its finally block.
      // Start it under cancellation so the same reader drains in that case too.
      if (!started) await stream.next();
      await stream.return();
    };

    return {
      events: {
        [Symbol.asyncIterator]() {
          return {
            next: () => stream.next(),
            return: async () => {
              await stop();
              return { done: true as const, value: undefined };
            },
          };
        },
      },
      turnId,
      get cancelled() {
        return cancelled;
      },
      cancel,
      stop,
      answerBudget(requestId, decision, provenance = { source: 'system' }): AnswerResult {
        if (released || cancelled || terminal || !budgets.has(requestId)) return { kind: 'stale' };
        if (decision.kind === 'extend' && (decision.grantedBy !== 'human' || provenance.source !== 'user'))
          return { kind: 'failed', error: modelError('Budget extension requires an explicit human answer') };
        if (decision.kind === 'steer')
          return { kind: 'failed', error: modelError('Use durable queued steering before resuming a budget wait') };
        if (
          !commit([
            {
              type: 'budget_closed',
              turnId,
              requestId,
              decision,
              source: provenance.source === 'user' ? 'user' : 'system',
            },
          ])
        ) {
          cancel();
          return { kind: 'failed', error: logFailure! };
        }
        budgets.delete(requestId);
        handle.answerBudget(requestId, decision);
        return { kind: 'accepted' };
      },
      answer(requestId, decision, provenance: AnswerProvenance = { source: 'system' }): AnswerResult {
        const request = requests.get(requestId);
        if (released || cancelled || terminal || !request) return { kind: 'stale' };
        if (!validDecision(request, decision))
          return { kind: 'failed', error: modelError('invalid interaction decision') };
        if (
          !commit([
            {
              type: 'interaction_closed',
              turnId,
              requestId,
              resolution: decision,
              resolutionSource: provenance.source,
              ...(provenance.automaticApproval !== undefined
                ? { automaticApproval: provenance.automaticApproval }
                : {}),
            },
          ])
        ) {
          cancel();
          return { kind: 'failed', error: logFailure! };
        }
        requests.delete(requestId);
        // Stop is continuation control, not cancellation: the selected allowed
        // body (or unanswered question result) must settle first. The engine
        // suppresses later bodies/model steps while retaining cleanup ownership.
        handle.answer(requestId, decision);
        return { kind: 'accepted' };
      },
    };
  }

  const start = (
    request: TurnRequest,
    planned?: {
      readonly turnId: TurnId;
      readonly facts: readonly Fact[];
      /** Command admission already committed replacement/start/receipt in one batch. */
      readonly accepted?: true;
      readonly silent?: true;
      readonly compaction?: true;
      readonly compactionState?: import('../engine/direct-types.js').TurnCompactionState;
      readonly history?: readonly Item[];
    },
  ): StartedConversationTurn => {
    if (closed) throw new Error(`conversation ${id} is closed`);
    if (rolloverDestination()) throw new Error(`Session rolled over to ${rolloverDestination()}`);
    if (active || (completionHeld && !planned?.accepted))
      throw new Error(`conversation ${id} already owns a foreground completion boundary`);
    if (commandOwner && !planned?.accepted) throw new Error('Session history is reserved by a command');
    if (logFailure || !recover()) throw new Error(logFailure!.message);
    if (
      request.submission &&
      (!request.submission.clientRequestId ||
        !request.input.some((item) => item.type === 'user_message' && item.id === request.submission!.messageId))
    ) {
      throw new Error('submission must identify one admitted user item');
    }
    const turnId = planned?.turnId ?? (`turn-${nextTurnId++}` as TurnId);
    const snapshot = planned?.accepted
      ? { history: planned.history!, compactionState: planned.compactionState }
      : liveReplay();
    const isHuman = !planned?.accepted && !planned?.silent && isDirectHumanOrigin(request.submission?.origin);
    const human = isHuman
      ? capabilities!.humanPlan(request.submission?.messageId ?? turnId, request.input)
      : { facts: capabilities!.memoryFacts(), modelInput: request.input };
    if (
      !planned?.accepted &&
      !commit([
        ...(planned?.facts ?? []),
        ...human.facts,
        {
          type: 'turn_started',
          ...(planned?.silent ? { silent: true as const } : {}),
          turnId,
          input: request.input,
          ...(directPreviewConfiguration(request) ? { requestConfiguration: directPreviewConfiguration(request) } : {}),
          ...(request.submission ? { submission: request.submission } : {}),
        },
      ])
    )
      throw new Error(logFailure!.message);
    const { input, notice: requestNotice, submission: _submission, previewMode: _previewMode, ...settings } = request;
    // Rejected admission, read-only preview, maintenance and empty retry input
    // cannot consume a pending profile transition. Like source pendingModeNotice,
    // this queue belongs to the live Session, not a second durable journal.
    const profileNotice =
      !planned?.compaction && input.some((item) => item.type === 'user_message') ? pendingProfileNotice : undefined;
    const notice = [profileNotice, requestNotice].filter(Boolean).join('\n\n') || undefined;
    if (profileNotice) pendingProfileNotice = undefined;
    // Old detached branches keep the exact generation that admitted their root.
    const turnDeps = runtimeDeps;
    const turnContinuity = continuity;
    try {
      const runNested: NonNullable<TurnDeps['runNested']> = async (nested, parent) => {
        if (!turnDeps.authorizeNested) throw new Error('App has not supplied direct nested authority');
        // Preserve the exact host-produced request for the surface's WeakMap authority lookup.
        const authority = await turnDeps.authorizeNested(nested, parent);
        parent.signal.throwIfAborted();
        const driver = createDirectBranchDriver({
          createDeps: (branchTurnId) => ({
            ...turnDeps,
            budget: runBudgets.open(branchTurnId, parent.turnId, turnDeps.budget),
            runNested,
            subagents: subagentPort,
          }),
          parentTurnId: parent.turnId,
          rootTurnId: turnId,
          authority,
          accept: (fact) => {
            if (!commit([fact])) throw new Error(logFailure!.message);
          },
          factFor,
          handles: branchHandles,
          publish: turnDeps.publishBranch,
        });
        const agents = new DirectSubagents({ tasks: tasks!, driver });
        const handle = agents.start({
          role: authority.role,
          task: authority.label,
          run: authority.request,
          workspace: authority.workspace,
          mode: nested.mode ?? 'foreground',
          ...(nested.name ? { name: nested.name } : {}),
          parentSignal: parent.signal,
          parentTurnId: parent.turnId,
          parentExecutionId: parent.parentExecutionId,
          ...(request.submission?.origin ? { origin: request.submission.origin } : {}),
        });
        if (nested.mode === 'background')
          return { runId: handle.runId, items: [], outcome: { kind: 'background', runId: handle.runId } };
        const result = await agents.waitForForeground(handle);
        if (result.kind === 'background')
          return { runId: handle.runId, items: [], outcome: { kind: 'background', runId: result.taskId } };
        if (result.result.value) return { ...result.result.value, runId: handle.runId };
        if (result.result.kind === 'failed')
          return { runId: handle.runId, items: [], outcome: { kind: 'failed', error: result.result.error } };
        return {
          runId: handle.runId,
          items: [],
          outcome: { kind: result.result.kind === 'cancelled' ? 'cancelled' : 'interrupted' },
        };
      };
      const handle = (planned?.compaction ? startCompaction : startTurn)(
        {
          ...settings,
          turnId,
          history: planned?.history ?? snapshot.history,
          ...(snapshot.compactionState ? { compactionState: snapshot.compactionState } : {}),
          newItems: notice ? withNotice(human.modelInput, notice) : human.modelInput,
        },
        {
          ...turnDeps,
          budget: runBudgets.open(turnId, undefined, turnDeps.budget),
          continuity: turnContinuity,
          takeSteering: boundary,
          prepareRequest: capabilities!.prepareRequest,
          normalStop: capabilities!.normalStop,
          runNested,
          subagents: subagentPort,
        },
      );
      const turn = ownTurn(turnId, handle);
      active = turn;
      if (planned) completionHeld = turnId;
      return { turnId, turn };
    } catch (error) {
      const failure = modelError(error);
      const ended = terminalFact(turnId, { kind: 'failed', error: failure });
      commit([{ ...ended, finalWindow: captureDirectFinalWindow(facts, ended) }]);
      return { turnId, turn: failedTurn(logFailure ?? failure) };
    }
  };
  const startEffect = (
    effect: Extract<DirectQueueEffect, { kind: 'start' }>,
    next: readonly Fact[],
  ): StartedConversationTurn => {
    if (!queueSettings) throw new Error('Queue dispatch lacks admitted request settings');
    return start(
      {
        ...queueSettings,
        input: effect.input,
        submission: {
          clientRequestId: effect.record.request.clientRequestId,
          messageId: effect.record.messageId,
          ...(effect.record.request.origin ? { origin: effect.record.request.origin } : {}),
        },
      },
      { turnId: effect.turnId, facts: next },
    );
  };
  const subagentPort: NonNullable<TurnDeps['subagents']> = (parent) => {
    const check = (): void => {
      parent.signal.throwIfAborted();
      if (closed || logFailure) throw new Error(logFailure?.message ?? 'Session is closed');
    };
    const get = (target: string): import('../tools/index.js').SubagentTaskState | undefined => {
      check();
      const task = tasks!.get(target) ?? taskStates.find((task) => task.taskId === target);
      return task?.kind === 'subagent' ? { ...task, kind: 'subagent' } : undefined;
    };
    return {
      list() {
        check();
        const live = new Map(tasks!.list().map((task) => [task.taskId, task]));
        return taskStates.flatMap((accepted) => {
          const task = live.get(accepted.taskId) ?? accepted;
          return task.kind === 'subagent' ? [{ ...task, kind: 'subagent' as const }] : [];
        });
      },
      get,
      async wait(target, signal) {
        const current = get(target);
        if (!current || current.result) return current;
        await tasks!.wait(current.taskId, AbortSignal.any([parent.signal, signal]));
        return get(current.taskId);
      },
      cancel(target) {
        const task = get(target);
        if (!task) return { ok: false, code: 'not_found' };
        if (task.result) return { ok: false, code: 'not_active' };
        return tasks!.requestStop(task.taskId);
      },
    };
  };
  const revision = (): string => `${id}:${historyRevision}`;
  const commandSnapshot = () =>
    captureDirectCommandHistory({
      sessionId: id,
      revision: revision(),
      facts,
      history: liveReplay().history,
      executionsSettled: !active && !completionHeld,
    });
  // Prepare every potentially throwing value before durable configuration acceptance.
  const prepareGeneration = (candidate: DirectPreparedConfiguration) => {
    if (
      candidate.capabilities.hooks !== supplied?.hooks ||
      candidate.capabilities.automaticMemory !== supplied?.automaticMemory ||
      candidate.capabilities.memory?.globalContext !== supplied?.memory?.globalContext ||
      candidate.capabilities.memory?.facts !== supplied?.memory?.facts
    )
      throw new Error('Configure attempted to replace the Session hooks or memory lifetime');
    const expectedWorkspace = deps.toolContext?.workspace;
    const nextWorkspace = candidate.deps.toolContext?.workspace;
    if (
      expectedWorkspace &&
      (!nextWorkspace ||
        nextWorkspace.root !== expectedWorkspace.root ||
        nextWorkspace.target !== expectedWorkspace.target ||
        nextWorkspace.access !== expectedWorkspace.access)
    )
      throw new Error('Configure cannot change Session workspace authority');
    if (
      candidate.profileTransitionNotice !== undefined &&
      (typeof candidate.profileTransitionNotice !== 'string' || !candidate.profileTransitionNotice.trim())
    )
      throw new Error('Profile transition notice must be nonempty text');
    const configurationFact = parseDirectConfigurationFact({
      type: 'configuration_changed',
      configuration: candidate.configuration,
      intent: candidate.intent,
      profile: candidate.profile,
    });
    const nextRequest = { ...candidate.request, model: candidate.configuration.model };
    const nextDeps: ConversationDeps = {
      ...candidate.deps,
      log: deps.log,
      context: deps.context,
      rotationBoundary: deps.rotationBoundary,
      configure: candidate.deps.configure ?? runtimeDeps.configure,
      rollover: candidate.deps.rollover ?? runtimeDeps.rollover,
      publishTask: deps.publishTask,
      publishBranch: deps.publishBranch,
      publishNotice: deps.publishNotice,
    };
    // Never reuse an opaque provider checkpoint across a configuration revision.
    const nextContinuity = nextDeps.continuity
      ? { ...nextDeps.continuity, state: nextDeps.continuity.state ?? new DirectContinuity() }
      : undefined;
    return { configurationFact, nextRequest, nextDeps, nextContinuity };
  };
  const installGeneration = (
    candidate: DirectPreparedConfiguration,
    prepared: ReturnType<typeof prepareGeneration>,
  ): void => {
    const { nextRequest, nextDeps, nextContinuity } = prepared;
    try {
      continuity?.state.clear();
      runtimeDeps = nextDeps;
      continuity = nextContinuity;
      configuredRequest = nextRequest;
      queueSettings = nextRequest;
      supplied = candidate.capabilities;
      capabilities!.replace(candidate.deps.tools, supplied);
      checkInSettings = supplied.backgroundCheckIns;
      candidate.install();
      if (candidate.profileTransitionNotice)
        pendingProfileNotice = [pendingProfileNotice, candidate.profileTransitionNotice].filter(Boolean).join('\n\n');
    } catch (error) {
      poison(error);
      throw error;
    }
  };
  // Live detached work is allowed. Only actual foreground/pending decisions veto.
  const rolloverBlocked = (commandId: string): boolean => {
    if (active || queueState.active) return true;
    if (completionHeld && directRolloverAtBoundary(facts, completionHeld)?.commandId !== commandId) return true;
    if (taskStates.some((task) => task.pendingInteractions.length > 0)) return true;
    const waiting = new Set<string>();
    for (const fact of facts) {
      if (fact.type === 'interaction_opened') waiting.add(fact.request.requestId);
      if (fact.type === 'budget_opened') waiting.add(fact.requestId);
      if (fact.type === 'interaction_closed' || fact.type === 'budget_closed') waiting.delete(fact.requestId);
    }
    return waiting.size > 0;
  };
  return {
    id,
    tasks,
    configureTaskCheckIn,
    currentRequest: (fallback) => configuredRequest ?? fallback,
    drainBackgroundNotifications(clientRequestId, settings) {
      if (!clientRequestId.trim()) throw new Error('Background drain requires a nonempty invocation ID');
      if (closed || logFailure || !recover())
        return { result: { kind: 'not_admitting', reason: logFailure?.message ?? 'Session is closed' } };
      const previous = notifications.deliveries.find((delivery) => delivery.clientRequestId === clientRequestId);
      if (previous)
        return {
          result: { kind: 'duplicate', turnId: previous.turnId, notificationIds: [...previous.notificationIds] },
        };
      if (rolloverDestination())
        return { result: { kind: 'not_admitting', reason: `Session rolled over to ${rolloverDestination()}` } };
      if (active || completionHeld || commandOwner || queueState.active || queueState.pending.length)
        return { result: { kind: 'busy' } };
      const notices = pendingDirectNotifications(notifications);
      if (!notices.length) return { result: { kind: 'empty' } };
      const turnId = `turn-${nextTurnId++}` as TurnId;
      const notificationIds = notices.map((notice) => notice.id);
      const started = start(
        {
          ...settings,
          input: [
            {
              type: 'user_message',
              id: `background:${randomUUID()}` as import('../model/index.js').ItemId,
              content: [{ type: 'text', text: notices.map((notice) => notice.text).join('\n\n') }],
            },
          ],
        },
        {
          turnId,
          silent: true,
          facts: [{ type: 'background_notices_delivered', clientRequestId, turnId, notificationIds }],
        },
      );
      return { result: { kind: 'started', turnId, notificationIds }, started };
    },
    cancelCommand() {
      commandOwner?.abort.abort();
    },
    commandRevision: revision,
    rewindTargets() {
      if (active || completionHeld || commandOwner || closed || logFailure) return [];
      return listDirectRewindTargets(commandSnapshot());
    },
    command(request, settings, settleForeground) {
      request = structuredClone(request);
      if (closed || logFailure || !recover())
        return Promise.resolve({
          result: { kind: 'not_admitting' as const, reason: logFailure?.message ?? 'Session is closed' },
        });
      const proposal = planDirectCommandStart(commandReceipts, request, revision());
      if (proposal.kind !== 'start')
        return Promise.resolve({
          result: proposal.kind === 'conflict' ? proposal : { ...structuredClone(proposal), replayed: true },
        });
      if (rolloverDestination())
        return Promise.resolve({
          result: { kind: 'not_admitting' as const, reason: `Session rolled over to ${rolloverDestination()}` },
        });
      // Reserve synchronously, before cancellation or any async model operation.
      if (!commit([proposal.fact])) throw new Error(logFailure!.message);
      const finish = (outcome: DirectCommandOutcome): DirectCommandResult => {
        if (!commit([planDirectCommandFinish(commandReceipts, request.commandId, outcome)]))
          throw new Error(logFailure!.message);
        return {
          kind: 'finished',
          replayed: false,
          receipt: structuredClone(commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!),
        };
      };
      // These optional caller preconditions are checked in this synchronous
      // admission, not in a host preflight followed by a racy later mutation.
      // The original keyed receipt was already replayed above; later state
      // must not turn that same invocation into a different outcome or grant.
      if (request.expectedRevision !== undefined && request.expectedRevision !== proposal.fact.revision)
        return Promise.resolve({
          result: finish({ kind: 'rejected', code: 'stale', message: 'The command revision is no longer current.' }),
        });
      if (
        request.admission === 'idle' &&
        (active || completionHeld || queueState.active || (!queueState.pause && queueState.pending.length > 0))
      )
        return Promise.resolve({
          result: finish({ kind: 'rejected', code: 'busy', message: 'This command requires an idle Session.' }),
        });
      const boundaryRollover = completionHeld ? directRolloverAtBoundary(facts, completionHeld) : undefined;
      if (
        boundaryRollover &&
        (request.commandId !== boundaryRollover.commandId || request.operation.kind !== 'rollover')
      )
        return Promise.resolve({
          result: finish({
            kind: 'rejected',
            code: 'busy',
            message: 'The settled root owns its accepted rollover boundary.',
          }),
        });
      if (commandOwner)
        return Promise.resolve({
          result: finish({ kind: 'rejected', code: 'busy', message: 'Another Session command owns history mutation.' }),
        });
      if (
        (request.operation.kind === 'configure' && !runtimeDeps.configure) ||
        (request.operation.kind === 'rollover' && !runtimeDeps.rollover) ||
        (request.operation.kind === 'compact' && !runtimeDeps.compaction)
      )
        return Promise.resolve({
          result: finish({
            kind: 'rejected',
            code: 'unavailable',
            message: `${request.operation.kind} lacks its actual native runtime authority.`,
          }),
        });
      if (request.operation.kind === 'configure' && (active || completionHeld || queueState.active))
        return Promise.resolve({
          result: finish({
            kind: 'rejected',
            code: 'busy',
            message: 'Stop the running turn before changing configuration.',
          }),
        });
      const owner = {
        commandId: request.commandId,
        kind: request.operation.kind,
        abort: new AbortController(),
        done: undefined as Promise<unknown> | undefined,
      };
      commandOwner = owner;
      const work = async (): Promise<{ result: DirectCommandResult; started?: StartedConversationTurn }> => {
        try {
          if (request.operation.kind === 'rollover') {
            if (!deps.rotationBoundary)
              return {
                result: finish({
                  kind: 'rejected',
                  code: 'unavailable',
                  message: 'Physical rotation authority is unavailable.',
                }),
              };
            if (rolloverBlocked(request.commandId))
              return {
                result: finish({
                  kind: 'rejected',
                  code: 'busy',
                  message: 'Settle the foreground and pending decisions before rollover.',
                }),
              };
            const expectedRevision = revision();
            let candidate: DirectPreparedConfiguration | undefined;
            let installed = false;
            try {
              const preparedRollover = await runtimeDeps.rollover!(request.operation.request, owner.abort.signal);
              if (preparedRollover.kind === 'rejected') return { result: finish(preparedRollover) };
              candidate = preparedRollover.generation;
              if (closed || logFailure || owner.abort.signal.aborted)
                return {
                  result: finish({
                    kind: 'rejected',
                    code: 'cancelled',
                    message: 'Rollover was cancelled before acceptance.',
                  }),
                };
              if (commandOwner !== owner || revision() !== expectedRevision)
                return {
                  result: finish({
                    kind: 'rejected',
                    code: 'stale',
                    message: 'Session history changed during rollover preparation.',
                  }),
                };
              if (rolloverBlocked(request.commandId))
                return {
                  result: finish({
                    kind: 'rejected',
                    code: 'busy',
                    message: 'A foreground decision arrived during rollover preparation.',
                  }),
                };
              if (Boolean(request.operation.request) !== (preparedRollover.handoff !== undefined))
                throw new Error('Rollover preparation must supply a brief exactly when one was requested');
              const prepared = prepareGeneration(candidate);
              const { type: _configurationType, ...selection } = prepared.configurationFact;
              const seedFacts: Fact[] = [];
              let seed:
                | { turnId: TurnId; input: readonly Item[]; submission: NonNullable<TurnRequest['submission']> }
                | undefined;
              let handoff: import('./direct-session-rotation.js').DirectSessionRotationFact['handoff'];
              if (preparedRollover.handoff !== undefined) {
                const clientRequestId = `rollover:${randomUUID()}`;
                const messageId = randomUUID();
                const turnId = `turn-${nextTurnId++}` as TurnId;
                const origin = { kind: 'control' as const, id: 'session-rollover' };
                const admission = submitDirectQueue(
                  queueState,
                  {
                    clientRequestId,
                    content: preparedRollover.handoff,
                    origin,
                    delivery: 'follow_up',
                  },
                  { ...environment(), newMessageId: () => messageId, newTurnId: () => turnId, dispatchHeld: true },
                );
                if (admission.result.kind !== 'queued') throw new Error('Rollover handoff could not be admitted');
                const record = admission.state.records.find((entry) => entry.messageId === messageId)!;
                const input: readonly Item[] = [
                  {
                    type: 'user_message',
                    id: messageId as import('../model/index.js').ItemId,
                    content: record.content,
                  },
                ];
                const submission = { clientRequestId, messageId, origin };
                // Decoder authorizes ONLY this header-correlated priority seed.
                const priorityStart = {
                  type: 'queue_started' as const,
                  messageId,
                  turnId,
                  rolloverCommandId: request.commandId,
                };
                seedFacts.push(...admission.facts, priorityStart, {
                  type: 'turn_started',
                  turnId,
                  input,
                  submission,
                  ...(directPreviewConfiguration({ ...prepared.nextRequest, input })
                    ? {
                        requestConfiguration: directPreviewConfiguration({ ...prepared.nextRequest, input }),
                      }
                    : {}),
                });
                seed = { turnId, input, submission };
                handoff = { clientRequestId, messageId, turnId };
              }
              // Progress during app preparation is valid: capture the REAL head
              // only after the final synchronous foreground/interaction veto.
              const boundary = deps.rotationBoundary();
              const rotation = parseDirectSessionRotation({
                type: 'session_rotated',
                logicalSessionId: id,
                sessionId: preparedRollover.successorId,
                predecessor: { sessionId: boundary.sessionId, throughSeq: boundary.seq },
                commandId: request.commandId,
                ...selection,
                history: [],
                ...(handoff ? { handoff } : {}),
              });
              const finished = planDirectCommandFinish(commandReceipts, request.commandId, {
                kind: 'rolled_over',
                sessionId: id,
              });
              if (!commit([rotation, ...seedFacts, finished])) throw new Error(logFailure!.message);
              installed = true; // Accepted generation ownership is never discarded.
              installGeneration(candidate, prepared);
              const started = seed
                ? start(
                    { ...prepared.nextRequest, input: seed.input, submission: seed.submission },
                    { turnId: seed.turnId, facts: [], accepted: true, history: [] },
                  )
                : undefined;
              return {
                result: {
                  kind: 'finished',
                  replayed: false,
                  receipt: structuredClone(
                    commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!,
                  ),
                },
                ...(started ? { started } : {}),
              };
            } finally {
              if (candidate && !installed) await candidate.dispose();
            }
          }
          if (request.operation.kind !== 'configure') {
            active?.cancel();
            await settleForeground();
            if (active) await active.stop();
          }
          if (closed || logFailure || owner.abort.signal.aborted)
            return {
              result: finish({
                kind: 'rejected',
                code: 'cancelled',
                message: 'Session command was cancelled before mutation.',
              }),
            };
          const operation = request.operation;
          if (operation.kind === 'configure') {
            const expectedRevision = revision();
            let candidate: DirectPreparedConfiguration | undefined;
            let installed = false;
            try {
              candidate = await runtimeDeps.configure!(operation.configuration, owner.abort.signal);
              if (
                closed ||
                logFailure ||
                owner.abort.signal.aborted ||
                commandOwner !== owner ||
                revision() !== expectedRevision
              )
                return {
                  result: finish({
                    kind: 'rejected',
                    code: owner.abort.signal.aborted || closed ? 'cancelled' : 'stale',
                    message: 'Prepared configuration lost its Session reservation or revision.',
                  }),
                };
              const prepared = prepareGeneration(candidate);
              const { configurationFact } = prepared;
              const finished = planDirectCommandFinish(commandReceipts, request.commandId, {
                kind: 'configured',
                configuration: candidate.configuration,
              });
              if (!commit([configurationFact, finished])) throw new Error(logFailure!.message);
              // Never discard a durably accepted generation, even if the app
              // violates its no-throw installation contract.
              installed = true;
              installGeneration(candidate, prepared);
              return {
                result: {
                  kind: 'finished',
                  replayed: false,
                  receipt: structuredClone(
                    commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!,
                  ),
                },
              };
            } finally {
              if (candidate && !installed) await candidate.dispose();
            }
          }
          if (operation.kind === 'compact') {
            const snapshot = commandSnapshot();
            if (!snapshot.executionsSettled)
              return {
                result: finish({ kind: 'rejected', code: 'busy', message: 'Foreground cleanup has not settled.' }),
              };
            const state = liveReplay();
            const turnId = `turn-${nextTurnId++}` as TurnId;
            const configuration = directPreviewConfiguration({ ...settings, input: [] });
            if (
              !commit([
                {
                  type: 'turn_started',
                  turnId,
                  input: [],
                  maintenance: { kind: 'compaction', commandId: request.commandId },
                  ...(configuration ? { requestConfiguration: configuration } : {}),
                },
              ])
            )
              throw new Error(logFailure!.message);
            const started = start(
              { ...settings, input: [] },
              {
                turnId,
                accepted: true,
                compaction: true,
                facts: [],
                history: state.history,
                compactionState: state.compactionState,
              },
            );
            const cancel = () => started.turn.cancel();
            owner.abort.signal.addEventListener('abort', cancel, { once: true });
            if (owner.abort.signal.aborted) cancel();
            let terminal: TurnResult | undefined;
            try {
              // Same Session reader/acceptance path as a conversational root.
              // Budget waits are published and answered through active.answerBudget.
              for await (const event of started.turn.events) if (event.type === 'turn_ended') terminal = event.result;
            } finally {
              owner.abort.signal.removeEventListener('abort', cancel);
              if (completionHeld === turnId) completionHeld = null;
            }
            if (terminal?.kind === 'completed' && terminal.compaction?.kind === 'compacted')
              return { result: finish({ kind: 'compacted' }) };
            return {
              result: finish({
                kind: 'rejected',
                code:
                  terminal?.kind === 'cancelled' || terminal?.kind === 'interrupted'
                    ? 'cancelled'
                    : terminal?.kind === 'completed'
                    ? 'ineligible'
                    : 'failed',
                message:
                  terminal?.kind === 'failed'
                    ? terminal.error.message
                    : terminal?.kind === 'completed' && terminal.compaction?.kind === 'blocked'
                    ? `Compaction did not replace history: ${terminal.compaction.reason}.`
                    : 'Compaction ended without an accepted history replacement.',
              }),
            };
          }
          const snapshot = commandSnapshot();
          if (operation.kind !== 'retry' && operation.kind !== 'rewind') throw new Error('Unsupported history command');
          const plan = planDirectHistoryCommand(snapshot, operation);
          if (plan.kind === 'rejected')
            return { result: finish({ kind: 'rejected', code: plan.code, message: plan.message }) };
          if (plan.expectedRevision !== revision() || commandOwner !== owner)
            return {
              result: finish({
                kind: 'rejected',
                code: 'stale',
                message: 'Session history changed before command acceptance.',
              }),
            };
          if (plan.next.kind === 'rewound') {
            const outcome = { kind: 'rewound' as const, draft: plan.next.draft };
            if (!commit([plan.fact, planDirectCommandFinish(commandReceipts, request.commandId, outcome)]))
              throw new Error(logFailure!.message);
            continuity?.state.clear();
            return {
              result: {
                kind: 'finished',
                replayed: false,
                receipt: structuredClone(
                  commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!,
                ),
              },
            };
          }
          const source = [...facts].reverse().find((fact) => fact.type === 'turn_started');
          const through = plan.fact.history.at(-1);
          if (source?.type !== 'turn_started' || !through)
            return {
              result: finish({
                kind: 'rejected',
                code: 'ineligible',
                message: 'Retry has no retained accepted root context.',
              }),
            };
          const turnId = `turn-${nextTurnId++}` as TurnId;
          const configuration = directPreviewConfiguration({ ...settings, input: [] });
          if (
            !commit([
              plan.fact,
              {
                type: 'turn_started',
                turnId,
                input: [],
                retryContext: { sourceTurnId: source.turnId, throughItemId: through.id },
                ...(configuration ? { requestConfiguration: configuration } : {}),
              },
              planDirectCommandFinish(commandReceipts, request.commandId, { kind: 'retried', turnId }),
            ])
          )
            throw new Error(logFailure!.message);
          continuity?.state.clear();
          const started = start(
            { ...settings, input: [] },
            { turnId, facts: [], accepted: true, history: plan.fact.history },
          );
          return {
            result: {
              kind: 'finished',
              replayed: false,
              receipt: structuredClone(
                commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!,
              ),
            },
            started,
          };
        } catch (error) {
          if (logFailure) throw new Error(logFailure.message);
          const accepted = commandReceipts.find((receipt) => receipt.request.commandId === request.commandId);
          if (accepted?.outcome)
            return { result: { kind: 'finished', replayed: false, receipt: structuredClone(accepted) } };
          return {
            result: finish({
              kind: 'rejected',
              code: 'failed',
              message: error instanceof Error ? error.message : String(error),
            }),
          };
        } finally {
          if (commandOwner === owner) commandOwner = null;
          const handoff = facts.find(
            (fact) => fact.type === 'rollover_requested' && fact.commandId === request.commandId,
          );
          if (handoff?.type === 'rollover_requested' && completionHeld === handoff.turnId && !active)
            completionHeld = null;
        }
      };
      const done = work();
      owner.done = done;
      return done;
    },
    abort(expectedTurnId, discardQueue = true) {
      if (closed || logFailure) return { kind: 'not_admitting', reason: logFailure?.message ?? 'session is closed' };
      const target = active?.turnId ?? completionHeld;
      if (target !== expectedTurnId || active?.cancelled)
        return {
          kind: 'no_op',
          turnId: expectedTurnId,
          status: facts.some((fact) => fact.type === 'turn_ended' && fact.turnId === expectedTurnId)
            ? 'terminal_accepted'
            : target === expectedTurnId && active?.cancelled
            ? 'cancellation_requested'
            : 'not_current',
        };
      const cancelPlan = planDirectQueue(queueState, { kind: 'cancel', turnId: expectedTurnId }, environment());
      const discardPlan = discardQueue
        ? planDirectQueue(cancelPlan.state, { kind: 'discard' }, environment())
        : undefined;
      const discardedMessageIds =
        discardPlan?.facts.flatMap((fact) => (fact.type === 'queue_discarded' ? [...fact.messageIds] : [])) ?? [];
      if (!commit([...cancelPlan.facts, ...(discardPlan?.facts ?? [])]))
        return { kind: 'not_admitting', reason: logFailure!.message };
      active?.cancel();
      return { kind: 'aborted', turnId: expectedTurnId, discardedMessageIds };
    },
    snapshotInputPreview(request) {
      if (closed || logFailure) throw new Error(logFailure?.message ?? 'Session is closed');
      const configuration = directPreviewConfiguration(request);
      if (!configuration) throw new Error('App has not supplied the effective previewMode');
      // Preview the accepted live cut, including in-flight Items/deltas, without
      // synthesizing crash-time tool results, wait closures or root terminals.
      // An unfinished projection's interrupted status is not a live failure.
      const history = replay(facts, { recoverQueue: false, recoverActiveTurn: false }).history;
      // This is the same pure admission plan, but its returned context facts are
      // deliberately NOT accepted. No memory/notice/goal state is consumed.
      const human = capabilities!.humanPlan('preview', request.input);
      const notice = [pendingProfileNotice, request.notice].filter(Boolean).join('\n\n');
      const modelInput = notice ? withNotice(human.modelInput, notice) : human.modelInput;
      const canonical: ModelRequest = {
        model: request.model,
        instructions: request.instructions,
        input: [...history, ...modelInput],
        tools: request.tools,
        ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        ...(request.providerOptions !== undefined ? { providerOptions: request.providerOptions } : {}),
      };
      const prepared = capabilities!.previewRequest(canonical);
      let selected = { request: prepared, chained: false };
      if (continuity) {
        // Engine owns this read-only selector. Never call prepare here: even an
        // unchainable preview must not clear a checkpoint or increment a ticket.
        selected = continuity.state!.preview(prepared, continuity.binding, true);
      }
      return structuredClone({
        input: selected.request.input,
        kind: selected.chained ? 'delta' : 'full_history',
        configuration,
        queueActive:
          !!active || !!completionHeld || !!queueState.active || (!queueState.pause && queueState.pending.length > 0),
        toolOccurrences: directPreviewOccurrences(facts, selected.request.input),
      });
    },
    rolloverAtBoundary: (turnId) => directRolloverAtBoundary(facts, turnId),
    context: () => structuredClone(context),
    setGoal(generation, goal, source = 'user') {
      if (closed || logFailure || !recover()) return false;
      return contextCommit(generation, [{ type: 'goal_changed', ...(goal ? { goal } : {}), source }]);
    },
    run(request) {
      try {
        return start(request).turn;
      } catch (error) {
        if (logFailure) return failedTurn(logFailure);
        throw error;
      }
    },
    submit(request, settings) {
      if (
        commandOwner?.kind === 'rollover' ||
        rolloverDestination() ||
        (completionHeld && directRolloverAtBoundary(facts, completionHeld))
      )
        return {
          admission: {
            kind: 'rejected',
            clientRequestId: request.clientRequestId,
            reason: rolloverDestination()
              ? `Session rolled over to ${rolloverDestination()}`
              : 'Session rollover is in progress',
          },
        };
      if (request.origin) {
        try {
          request = { ...request, origin: parseDirectOrigin(request.origin) };
        } catch {
          return {
            admission: { kind: 'rejected', clientRequestId: request.clientRequestId, reason: 'invalid origin' },
          };
        }
      }
      if (closed || logFailure || !recover())
        return {
          admission: {
            kind: 'rejected',
            clientRequestId: request.clientRequestId,
            reason: logFailure?.message ?? 'session is closed',
          },
        };
      const plan = submitDirectQueue(queueState, request, environment());
      queueSettings = settings;
      if (plan.effect?.kind === 'start') {
        const started = startEffect(plan.effect, plan.facts);
        return { admission: plan.result, started };
      }
      if (!commit(plan.facts))
        return {
          admission: { kind: 'rejected', clientRequestId: request.clientRequestId, reason: logFailure!.message },
        };
      return { admission: plan.result };
    },
    queue(command) {
      if (closed || logFailure || !recover()) return { kind: 'rejected', reason: 'invalid' };
      if (command.kind === 'settled' && commandOwner) command = { ...command, preservePendingSteers: true };
      const plan = planDirectQueue(queueState, command, environment());
      if (plan.effect?.kind === 'start') throw new Error('Use advanceQueue for dispatch');
      if (!commit(plan.facts)) return { kind: 'rejected', reason: 'invalid' };
      if (
        command.kind === 'settled' &&
        command.turnId === completionHeld &&
        !directRolloverAtBoundary(facts, command.turnId)
      )
        completionHeld = null;
      if (plan.effect?.kind === 'cancel') active?.cancel();
      return plan.result;
    },
    advanceQueue(settings) {
      if (settings) queueSettings = settings;
      if (active || commandOwner || closed || logFailure || rolloverDestination() || !queueSettings) return undefined;
      const plan = planDirectQueue(queueState, { kind: 'dispatch' }, environment());
      if (plan.effect?.kind === 'start') return startEffect(plan.effect, plan.facts);
      if (!commit(plan.facts)) throw new Error(logFailure!.message);
      return undefined;
    },
    answerBudget(requestId, decision, provenance) {
      return active?.answerBudget(requestId, decision, provenance) ?? { kind: 'stale' };
    },
    answer(requestId, decision, provenance) {
      if (closed || logFailure) return logFailure ? { kind: 'failed', error: logFailure } : { kind: 'stale' };
      const root = active?.answer(requestId, decision, provenance);
      if (root && root.kind !== 'stale') return root;
      return tasks!.answer(requestId, decision);
    },
    async close() {
      closed = true;
      if (checkInTimer) clearInterval(checkInTimer);
      commandOwner?.abort.abort();
      try {
        await commandOwner?.done;
        await Promise.all([active?.stop(), tasks!.close()]);
        await capabilities!.close(!!logFailure);
      } finally {
        deps.log.close();
      }
    },
  };
}

const lostTerminal: TurnResult = {
  kind: 'failed',
  error: { kind: 'provider', message: 'turn ended without a terminal event', retryable: false },
};

function modelError(error: unknown): ModelError {
  return { kind: 'provider', message: error instanceof Error ? error.message : String(error), retryable: false };
}

function validDecision(request: InteractionRequest, decision: InteractionDecision): boolean {
  if (!decision || typeof decision !== 'object') return false;
  if (decision.stopAfterApprovalResolution !== undefined && typeof decision.stopAfterApprovalResolution !== 'boolean')
    return false;
  if (request.kind === 'question') return decision.kind === 'answer' && typeof decision.answer === 'string';
  return (
    decision.kind === 'allow' ||
    (decision.kind === 'deny' && (decision.reason === undefined || typeof decision.reason === 'string'))
  );
}

function failedTurn(error: ModelError): Turn {
  return {
    events: (async function* () {
      yield { type: 'turn_ended', result: { kind: 'failed', error } } as const;
    })(),
    cancel() {},
    answer: () => ({ kind: 'stale' }),
    answerBudget: () => ({ kind: 'stale' }),
  };
}

/** Reasoning/progress/attempt notices stay transient; authority-bearing facts fsync. */
function factFor(
  turnId: TurnId,
  event: Exclude<TurnEvent, { type: 'turn_ended' }>,
): DirectTurnFact | DirectHistoryFact | null {
  switch (event.type) {
    case 'text_delta':
      return {
        type: 'text_delta',
        turnId,
        delta: event.delta,
        ...(event.modelStep !== undefined ? { modelStep: event.modelStep } : {}),
      };
    case 'item':
      return {
        type: 'item',
        turnId,
        item: event.item,
        ...(event.executionId !== undefined ? { executionId: event.executionId } : {}),
        ...(event.modelStep !== undefined ? { modelStep: event.modelStep } : {}),
      };
    case 'budget_required':
      return { ...event, type: 'budget_opened' };
    case 'budget_observed':
      return { ...event, turnId };
    case 'compaction_started':
    case 'compaction_completed':
    case 'compaction_failed':
    case 'model_response_completed':
      return { ...event, turnId };
    case 'history_replaced':
      return { ...event, turnId };
    case 'usage':
      return {
        type: 'usage',
        turnId,
        usage: event.usage,
        ...(event.modelStep !== undefined ? { modelStep: event.modelStep } : {}),
      };
    case 'tool_start_requested':
      return {
        type: 'tool_started',
        turnId,
        executionId: event.executionId,
        callId: event.callId,
        toolName: event.toolName,
        input: event.input,
        ...(event.parentExecutionId !== undefined ? { parentExecutionId: event.parentExecutionId } : {}),
      };
    case 'tool_execution_finished':
      return { type: 'tool_finished', turnId, executionId: event.executionId, result: event.result };
    case 'interaction_required':
      return { type: 'interaction_opened', turnId, request: event.request };
    default:
      return null;
  }
}

function terminalFact(turnId: TurnId, result: TurnResult): Extract<Fact, { type: 'turn_ended' }> {
  return {
    type: 'turn_ended',
    turnId,
    outcome: result.kind,
    ...(result.kind === 'failed' ? { error: result.error } : {}),
    ...('terminalCause' in result && result.terminalCause ? { terminalCause: result.terminalCause } : {}),
    ...('notice' in result && result.notice ? { notice: result.notice } : {}),
  };
}

/** Notice is request-only: durable user history retains the user's exact input. */
function withNotice(input: readonly Item[], notice: string): readonly Item[] {
  let prefixed = false;
  return input.map((item) => {
    if (prefixed || item.type !== 'user_message') return item;
    const textIndex = item.content.findIndex((part) => part.type === 'text');
    const part = item.content[textIndex];
    if (part?.type !== 'text') {
      prefixed = true;
      return { ...item, content: [{ type: 'text', text: notice }, ...item.content] };
    }
    prefixed = true;
    const content = [...item.content];
    content[textIndex] = { ...part, text: `${notice}\n\n${part.text}` };
    return { ...item, content };
  });
}

/** Physical audit/branch progress and compaction lifecycle do not invalidate a
 * root history token. For compaction, history_replaced alone owns transcript mutation. */
function changesRootHistory(fact: Fact): boolean {
  return [
    'turn_started',
    'turn_ended',
    'text_delta',
    'item',
    'history_replaced',
    'configuration_changed',
    'session_rotated',
    'queue_steered',
    'memory_personal_snapshot',
  ].includes(fact.type);
}
