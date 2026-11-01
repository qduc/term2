import { ConversationJournal, modelError } from './conversation-journal.js';
import { ownConversationTurn, factFor, terminalFact, failedTurn } from './conversation-turn.js';
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
  directQuestionNotice,
  isDirectNotificationFactType,
  pendingDirectNotifications,
  reduceDirectNotifications,
  type DirectNotificationFact,
  type DirectNotificationState,
} from './direct-notifications.js';
import type { DirectPreparedConfiguration } from './direct-configuration.js';
import {
  installConversationGeneration,
  prepareConversationGeneration,
  type PreparedConversationGeneration,
} from './conversation-generation.js';
import { directRolloverAtBoundary } from './direct-rollover.js';
import { parseDirectSessionRotation } from './direct-session-rotation.js';
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
import {
  DirectContinuity,
  type DirectContinuityBinding,
  type PreparedDirectRequest,
} from '../engine/direct-recovery-continuity.js';
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
  let commandOwner: {
    readonly commandId: string;
    readonly kind: import('./direct-command-types.js').DirectCommandOperation['kind'];
    readonly abort: AbortController;
    done?: Promise<unknown>;
  } | null = null;
  const rolloverDestination = (): string | undefined => {
    for (const receipt of journal.commandReceipts) {
      if (receipt.outcome?.kind === 'rolled_over' && receipt.outcome.sessionId !== id) return receipt.outcome.sessionId;
    }
    return undefined;
  };
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
  let completionHeld: TurnId | null = null;
  const branchHandles = new Set<TurnHandle>();
  const runBudgets = new DirectRunBudgets(
    deps.budget,
    (fact) => {
      if (!commit([fact])) throw new Error(journal.failure!.message);
    },
    facts,
  );
  let tasks: BackgroundTasksType | undefined;
  let capabilities: ReturnType<typeof bindDirectCapabilities> | undefined;
  let closed = false;

  const journal = new ConversationJournal(deps.log, facts, {
    accepted: (line) => capabilities?.accepted(line),
    status: (...args) => capabilities?.status(...args),
    failed(error) {
      tasks?.poison(error);
      active?.cancel();
      commandOwner?.abort.abort();
      for (const handle of branchHandles) handle.cancel();
    },
  });
  const { commit, liveReplay, recover, poison } = journal;
  const writerFailure = (): ModelError | null => journal.failure;
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
        const previous = journal.taskStates.find((task) => task.taskId === taskId);
        const notice =
          previous &&
          !closed &&
          (fact.type === 'task_question_opened'
            ? directQuestionNotice(previous, fact.question)
            : fact.type === 'task_backgrounded'
            ? directTaskNotice(previous, 'background')
            : fact.type === 'task_stop_requested'
            ? directTaskNotice(previous, 'stop')
            : fact.type === 'task_finished' && previous.mode === 'background'
            ? directTaskNotice(previous, 'finished', fact.result)
            : undefined);
        if (
          (closed &&
            (fact.type === 'task_started' ||
              fact.type === 'task_interaction_opened' ||
              fact.type === 'task_question_opened')) ||
          !recover() ||
          !commit([fact, ...(notice ? [{ type: 'background_notice_enqueued' as const, notice }] : [])])
        )
          throw new Error(journal.failure?.message ?? 'Session is closed');
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
      if (closed || journal.failure) return;
      if (!commit([{ type: 'background_notice_enqueued', notice: directCheckInNotice(event) }]))
        throw new Error(journal.failure!.message);
    },
  });
  const configureTaskCheckIn: Conversation['configureTaskCheckIn'] = (target, policy) =>
    closed || journal.failure ? { ok: false, code: 'not_active' } : checkIns.configure(target, policy);
  const contextCommit = (generation: number, next: readonly DirectContextFact[], turnId?: TurnId): boolean => {
    if (
      closed ||
      journal.failure ||
      journal.context.goal.generation !== generation ||
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
    read: () => structuredClone(journal.context),
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
    read: () => journal.context,
    facts: () => facts,
    commit: contextCommit,
    validTurn: (turnId) => !!active && active.turnId === turnId && !active.cancelled && !closed && !journal.failure,
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
        journal.failure
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
          journal.context.goal.generation,
          [{ type: 'rollover_requested', turnId, commandId, request: structuredClone(request) }],
          turnId,
        )
      )
        return {
          ok: false,
          status: 'rollover_blocked',
          error: writerFailure()?.message ?? 'The handoff was not accepted.',
        };
      completionHeld = turnId;
      return { ok: true, status: 'rollover_requested', rolloverId: commandId };
    },
  });
  for (const entry of newEntries) capabilities.accepted(entry);
  const environment = () => ({
    newMessageId: randomUUID,
    newTurnId: () => `turn-${nextTurnId++}` as TurnId,
    now: () => new Date().toISOString(),
    dispatchHeld: !!active || !!completionHeld || !!commandOwner || closed || !!journal.failure,
  });
  const boundary = (turnId: TurnId): readonly Item[] => {
    if (!active || active.turnId !== turnId || active.cancelled || commandOwner || closed || journal.failure) return [];
    const plan = planDirectQueue(journal.queueState, { kind: 'boundary', turnId }, environment());
    if (!commit(plan.facts)) throw new Error(journal.failure!.message);
    return plan.effect?.kind === 'steer' ? plan.effect.modelInput : [];
  };

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
    if (journal.failure || !recover()) throw new Error(journal.failure!.message);
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
      throw new Error(journal.failure!.message);
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
            onTurnBoundary: ({ turnId }) => tasks!.releaseParent(turnId),
            budget: runBudgets.open(branchTurnId, parent.turnId, turnDeps.budget),
            runNested,
            subagents: subagentPort,
          }),
          parentTurnId: parent.turnId,
          rootTurnId: turnId,
          authority,
          accept: (fact) => {
            if (!commit([fact])) throw new Error(journal.failure!.message);
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
          onTurnBoundary: ({ turnId }) => tasks!.releaseParent(turnId),
          budget: runBudgets.open(turnId, undefined, turnDeps.budget),
          continuity: turnContinuity,
          takeSteering: boundary,
          prepareRequest: capabilities!.prepareRequest,
          normalStop: capabilities!.normalStop,
          runNested,
          subagents: subagentPort,
        },
      );
      const turn = ownConversationTurn(turnId, handle, journal, {
        capabilities: capabilities!,
        publishNotice: deps.publishNotice,
        released: () => {
          if (active?.turnId === turnId) active = null;
        },
      });
      active = turn;
      if (planned) completionHeld = turnId;
      return { turnId, turn };
    } catch (error) {
      const failure = modelError(error);
      const ended = terminalFact(turnId, { kind: 'failed', error: failure });
      commit([ended]);
      return { turnId, turn: failedTurn(journal.failure ?? failure) };
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
      if (closed || journal.failure) throw new Error(journal.failure?.message ?? 'Session is closed');
    };
    const get = (target: string): import('../tools/index.js').SubagentTaskState | undefined => {
      check();
      const task = tasks!.get(target) ?? journal.taskStates.find((task) => task.taskId === target);
      return task?.kind === 'subagent' ? { ...task, kind: 'subagent' } : undefined;
    };
    return {
      list() {
        check();
        const live = new Map(tasks!.list().map((task) => [task.taskId, task]));
        return journal.taskStates.flatMap((accepted) => {
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
      message(target, message, replyTo) {
        check();
        return tasks!.message(target, message, replyTo);
      },
      cancel(target) {
        const task = get(target);
        if (!task) return { ok: false, code: 'not_found' };
        if (task.result) return { ok: false, code: 'not_active' };
        return tasks!.requestStop(task.taskId);
      },
    };
  };
  const revision = (): string => `${id}:${journal.historyRevision}`;
  const commandSnapshot = () =>
    captureDirectCommandHistory({
      sessionId: id,
      revision: revision(),
      facts,
      history: liveReplay().history,
      executionsSettled: !active && !completionHeld,
    });
  // Prepare every potentially throwing value before durable configuration acceptance.
  const prepareGeneration = (candidate: DirectPreparedConfiguration): PreparedConversationGeneration =>
    prepareConversationGeneration(deps, runtimeDeps, supplied, candidate);
  const installGeneration = (
    candidate: DirectPreparedConfiguration,
    prepared: ReturnType<typeof prepareGeneration>,
  ): void => {
    try {
      installConversationGeneration(
        candidate,
        prepared,
        continuity,
        capabilities!.replace,
        (generation) => {
          runtimeDeps = generation.nextDeps;
          continuity = generation.nextContinuity;
          configuredRequest = generation.nextRequest;
          queueSettings = generation.nextRequest;
          supplied = candidate.capabilities;
          checkInSettings = supplied.backgroundCheckIns;
        },
        (notice) => {
          if (notice) pendingProfileNotice = [pendingProfileNotice, notice].filter(Boolean).join('\n\n');
        },
      );
    } catch (error) {
      poison(error);
      throw error;
    }
  };
  // Live detached work is allowed. Only actual foreground/pending decisions veto.
  const rolloverBlocked = (commandId: string): boolean => {
    if (active || journal.queueState.active) return true;
    if (completionHeld && directRolloverAtBoundary(facts, completionHeld)?.commandId !== commandId) return true;
    if (journal.taskStates.some((task) => task.pendingInteractions.length > 0)) return true;
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
      if (closed || journal.failure || !recover())
        return { result: { kind: 'not_admitting', reason: journal.failure?.message ?? 'Session is closed' } };
      const previous = journal.notifications.deliveries.find(
        (delivery) => delivery.clientRequestId === clientRequestId,
      );
      if (previous)
        return {
          result: { kind: 'duplicate', turnId: previous.turnId, notificationIds: [...previous.notificationIds] },
        };
      if (rolloverDestination())
        return { result: { kind: 'not_admitting', reason: `Session rolled over to ${rolloverDestination()}` } };
      if (active || completionHeld || commandOwner || journal.queueState.active || journal.queueState.pending.length)
        return { result: { kind: 'busy' } };
      // Only accepted closure disproves a question notice. In particular, a
      // recovered interrupted task has no live continuation to answer. Preserve
      // other notices and unknown questions, and keep historical deliveries valid.
      const closedQuestions = new Set(
        facts.flatMap((fact) =>
          fact.type === 'task_question_closed' ? [`question:${fact.taskId}:${fact.messageId}`] : [],
        ),
      );
      const notices = pendingDirectNotifications(journal.notifications).filter(
        (notice) => notice.kind !== 'question' || !closedQuestions.has(notice.id),
      );
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
      if (active || completionHeld || commandOwner || closed || journal.failure) return [];
      return listDirectRewindTargets(commandSnapshot());
    },
    command(request, settings, settleForeground) {
      request = structuredClone(request);
      if (closed || journal.failure || !recover())
        return Promise.resolve({
          result: { kind: 'not_admitting' as const, reason: journal.failure?.message ?? 'Session is closed' },
        });
      const proposal = planDirectCommandStart(journal.commandReceipts, request, revision());
      if (proposal.kind !== 'start')
        return Promise.resolve({
          result: proposal.kind === 'conflict' ? proposal : { ...structuredClone(proposal), replayed: true },
        });
      if (rolloverDestination())
        return Promise.resolve({
          result: { kind: 'not_admitting' as const, reason: `Session rolled over to ${rolloverDestination()}` },
        });
      // Reserve synchronously, before cancellation or any async model operation.
      if (!commit([proposal.fact])) throw new Error(journal.failure!.message);
      const finish = (outcome: DirectCommandOutcome): DirectCommandResult => {
        if (!commit([planDirectCommandFinish(journal.commandReceipts, request.commandId, outcome)]))
          throw new Error(journal.failure!.message);
        return {
          kind: 'finished',
          replayed: false,
          receipt: structuredClone(
            journal.commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!,
          ),
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
        (active ||
          completionHeld ||
          journal.queueState.active ||
          (!journal.queueState.pause && journal.queueState.pending.length > 0))
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
      if (request.operation.kind === 'configure' && (active || completionHeld || journal.queueState.active))
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
              if (closed || journal.failure || owner.abort.signal.aborted)
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
                  journal.queueState,
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
                  ...(directPreviewConfiguration(prepared.nextRequest)
                    ? {
                        requestConfiguration: directPreviewConfiguration(prepared.nextRequest),
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
              const finished = planDirectCommandFinish(journal.commandReceipts, request.commandId, {
                kind: 'rolled_over',
                sessionId: id,
              });
              if (!commit([rotation, ...seedFacts, finished])) throw new Error(journal.failure!.message);
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
                    journal.commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!,
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
          if (closed || journal.failure || owner.abort.signal.aborted)
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
                journal.failure ||
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
              const finished = planDirectCommandFinish(journal.commandReceipts, request.commandId, {
                kind: 'configured',
                configuration: candidate.configuration,
              });
              if (!commit([configurationFact, finished])) throw new Error(journal.failure!.message);
              // Never discard a durably accepted generation, even if the app
              // violates its no-throw installation contract.
              installed = true;
              installGeneration(candidate, prepared);
              return {
                result: {
                  kind: 'finished',
                  replayed: false,
                  receipt: structuredClone(
                    journal.commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!,
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
            const configuration = directPreviewConfiguration(settings);
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
              throw new Error(journal.failure!.message);
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
            if (!commit([plan.fact, planDirectCommandFinish(journal.commandReceipts, request.commandId, outcome)]))
              throw new Error(journal.failure!.message);
            continuity?.state.clear();
            return {
              result: {
                kind: 'finished',
                replayed: false,
                receipt: structuredClone(
                  journal.commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!,
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
                message: 'Retry has no retained accepted root journal.context.',
              }),
            };
          const turnId = `turn-${nextTurnId++}` as TurnId;
          const configuration = directPreviewConfiguration(settings);
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
              planDirectCommandFinish(journal.commandReceipts, request.commandId, { kind: 'retried', turnId }),
            ])
          )
            throw new Error(journal.failure!.message);
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
                journal.commandReceipts.find((receipt) => receipt.request.commandId === request.commandId)!,
              ),
            },
            started,
          };
        } catch (error) {
          if (journal.failure) throw new Error(journal.failure.message);
          const accepted = journal.commandReceipts.find((receipt) => receipt.request.commandId === request.commandId);
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
      if (closed || journal.failure)
        return { kind: 'not_admitting', reason: journal.failure?.message ?? 'session is closed' };
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
      const cancelPlan = planDirectQueue(journal.queueState, { kind: 'cancel', turnId: expectedTurnId }, environment());
      const discardPlan = discardQueue
        ? planDirectQueue(cancelPlan.state, { kind: 'discard' }, environment())
        : undefined;
      const discardedMessageIds =
        discardPlan?.facts.flatMap((fact) => (fact.type === 'queue_discarded' ? [...fact.messageIds] : [])) ?? [];
      if (!commit([...cancelPlan.facts, ...(discardPlan?.facts ?? [])]))
        return { kind: 'not_admitting', reason: journal.failure!.message };
      active?.cancel();
      return { kind: 'aborted', turnId: expectedTurnId, discardedMessageIds };
    },
    snapshotInputPreview(request) {
      if (closed || journal.failure) throw new Error(journal.failure?.message ?? 'Session is closed');
      const configuration = directPreviewConfiguration(request);
      if (!configuration) throw new Error('App has not supplied the effective previewMode');
      // Preview the accepted live cut, including in-flight Items/deltas, without
      // synthesizing crash-time tool results, wait closures or root terminals.
      // An unfinished projection's interrupted status is not a live failure.
      const history = replay(facts, { recoverQueue: false, recoverActiveTurn: false }).history;
      // This is the same pure admission plan, but its returned journal.context facts are
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
      let selected: Omit<PreparedDirectRequest, 'ticket'> = { request: prepared, chained: false };
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
          !!active ||
          !!completionHeld ||
          !!journal.queueState.active ||
          (!journal.queueState.pause && journal.queueState.pending.length > 0),
        toolOccurrences: directPreviewOccurrences(facts, selected.request.input),
      });
    },
    rolloverAtBoundary: (turnId) => directRolloverAtBoundary(facts, turnId),
    context: () => structuredClone(journal.context),
    setGoal(generation, goal, source = 'user') {
      if (closed || journal.failure || !recover()) return false;
      return contextCommit(generation, [{ type: 'goal_changed', ...(goal ? { goal } : {}), source }]);
    },
    run(request) {
      try {
        return start(request).turn;
      } catch (error) {
        if (journal.failure) return failedTurn(journal.failure);
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
      if (closed || journal.failure || !recover())
        return {
          admission: {
            kind: 'rejected',
            clientRequestId: request.clientRequestId,
            reason: journal.failure?.message ?? 'session is closed',
          },
        };
      const plan = submitDirectQueue(journal.queueState, request, environment());
      queueSettings = settings;
      if (plan.effect?.kind === 'start') {
        const started = startEffect(plan.effect, plan.facts);
        return { admission: plan.result, started };
      }
      if (!commit(plan.facts))
        return {
          admission: { kind: 'rejected', clientRequestId: request.clientRequestId, reason: journal.failure!.message },
        };
      return { admission: plan.result };
    },
    queue(command) {
      if (closed || journal.failure || !recover()) return { kind: 'rejected', reason: 'invalid' };
      if (command.kind === 'settled' && commandOwner) command = { ...command, preservePendingSteers: true };
      const plan = planDirectQueue(journal.queueState, command, environment());
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
      if (active || commandOwner || closed || journal.failure || rolloverDestination() || !queueSettings)
        return undefined;
      const plan = planDirectQueue(journal.queueState, { kind: 'dispatch' }, environment());
      if (plan.effect?.kind === 'start') return startEffect(plan.effect, plan.facts);
      if (!commit(plan.facts)) throw new Error(journal.failure!.message);
      return undefined;
    },
    answerBudget(requestId, decision, provenance) {
      return active?.answerBudget(requestId, decision, provenance) ?? { kind: 'stale' };
    },
    answer(requestId, decision, provenance) {
      if (closed || journal.failure)
        return journal.failure ? { kind: 'failed', error: journal.failure } : { kind: 'stale' };
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
        await capabilities!.close(!!journal.failure);
      } finally {
        deps.log.close();
      }
    },
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
