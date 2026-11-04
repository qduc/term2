import { abortConversation } from './conversation-abort.js';
import { ConversationBackground } from './conversation-background.js';
import { ConversationCommands } from './conversation-commands.js';
import { ConversationJournal, modelError, nextConversationTurnId } from './conversation-journal.js';
import { failedTurn, ownConversationTurn, terminalFact, type OwnedConversationTurn } from './conversation-turn.js';
import { prepareConversationNotice } from './conversation-notice.js';
/**
 * The direct conversation owns the engine reader and the durable writer. An
 * engine envelope is accepted only after its fact has committed. Public events
 * contain no acceptance capability; answers likewise commit before release.
 * Cancellation/consumer return retains turn ownership through physical cleanup.
 */
import { randomUUID } from 'node:crypto';
import type { TurnId } from '../engine/index.js';
import { startCompaction, startTurn } from '../engine/index.js';
import type { Item, ModelError } from '../model/index.js';
import { ConversationGeneration, type PreparedConversationGeneration } from './conversation-generation.js';
import { bindDirectCapabilities } from './direct-capabilities.js';
import type { DirectPreparedConfiguration } from './direct-configuration.js';
import { type DirectContextFact } from './direct-context.js';
import { planDirectTiming } from './direct-time-gap.js';
import { parseDirectOrigin } from './direct-origin.js';
import type { DirectQueueEffect } from './direct-queue-types.js';
import { planDirectQueue, submitDirectQueue } from './direct-queue.js';
import { directRolloverAtBoundary } from './direct-rollover.js';
import { DirectRunBudgets } from './direct-run-budget.js';
import type { Conversation, ConversationDeps, StartedConversationTurn, TurnRequest } from './direct-types.js';
import type { Fact, FactLine, SessionStartedFact } from './facts.js';
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
  // Replay the journal's own array so its fold is kept for the first turn's boundary replays.
  const facts = [...deps.facts];
  replay(facts);
  return conversation(deps, started.id, facts);
}

function conversation(
  deps: ConversationDeps,
  id: string,
  facts: Fact[],
  newEntries: readonly FactLine[] = [],
): Conversation {
  let active: OwnedConversationTurn | null = null;
  const generation = new ConversationGeneration(deps);
  let nextTurnId = nextConversationTurnId(facts);
  let queueSettings: Omit<TurnRequest, 'input' | 'submission'> | undefined;
  let completionHeld: TurnId | null = null;
  const runBudgets = new DirectRunBudgets(
    deps.budget,
    (fact) => {
      if (!commit([fact])) throw new Error(journal.failure!.message);
    },
    facts,
  );
  let background: ConversationBackground | undefined;
  let capabilities: ReturnType<typeof bindDirectCapabilities> | undefined;
  let closed = false;

  const journal = new ConversationJournal(deps.log, facts, {
    accepted: (line) => capabilities?.accepted(line),
    status: (...args) => capabilities?.status(...args),
    failed(error) {
      background?.poison(error);
      active?.cancel();
      commands.owner?.abort.abort();
    },
  });
  const { commit, liveReplay, recover, poison } = journal;
  const writerFailure = (): ModelError | null => journal.failure;
  const commands = new ConversationCommands(
    id,
    journal,
    generation,
    {
      get closed() {
        return closed;
      },
      get active() {
        return active;
      },
      get completionHeld() {
        return completionHeld;
      },
      releaseCompletion(turnId) {
        if (completionHeld === turnId) completionHeld = null;
      },
      newTurnId: () => `turn-${nextTurnId++}` as TurnId,
      environment: () => environment(),
      start: (...args) => start(...args),
    },
    deps.rotationBoundary,
    (candidate, prepared) => installGeneration(candidate, prepared),
  );
  background = new ConversationBackground(deps, journal, generation, runBudgets, {
    get closed() {
      return closed;
    },
    newTurnId: () => `turn-${nextTurnId++}` as TurnId,
    start: (...args) => start(...args),
    busy: () =>
      !!active ||
      !!completionHeld ||
      !!commands.owner ||
      !!journal.queueState.active ||
      !!journal.queueState.pending.length,
    destination: () => commands.destination(),
  });
  const tasks = background.tasks;
  const configureTaskCheckIn = background.configureTaskCheckIn;
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
  generation.supplied = deps.context?.({
    sessionId: id,
    get backingSessionId() {
      return deps.rotationBoundary?.().sessionId ?? id;
    },
    read: () => structuredClone(journal.context),
    commit: (generation, next) => contextCommit(generation, next),
    tasks,
    configureTaskCheckIn,
  });
  background.startCheckIns();
  capabilities = bindDirectCapabilities({
    sessionId: id,
    read: () => journal.context,
    facts: () => facts,
    commit: contextCommit,
    validTurn: (turnId) => !!active && active.turnId === turnId && !active.cancelled && !closed && !journal.failure,
    baseTools: deps.tools,
    capabilities: generation.supplied,
    canRollover: () => !!generation.runtime.rollover,
    requestRollover(turnId, request) {
      if (
        !generation.runtime.rollover ||
        !active ||
        active.turnId !== turnId ||
        active.cancelled ||
        commands.owner ||
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
    dispatchHeld: !!active || !!completionHeld || !!commands.owner || closed || !!journal.failure,
  });
  const boundary = (turnId: TurnId): readonly Item[] => {
    if (!active || active.turnId !== turnId || active.cancelled || commands.owner || closed || journal.failure)
      return [];
    const plan = planDirectQueue(journal.queueState, { kind: 'boundary', turnId }, environment());
    const input =
      plan.effect?.kind === 'steer'
        ? planDirectTiming(journal.context.latestHumanInputAt, journal.queueState.records, plan.effect.modelInput)
            .modelInput
        : [];
    if (!commit(plan.facts)) throw new Error(journal.failure!.message);
    return input;
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
      readonly retryNotice?: { readonly messageId: Item['id']; readonly text: string };
      readonly compactionState?: import('../engine/direct-types.js').TurnCompactionState;
      readonly history?: readonly Item[];
    },
  ): StartedConversationTurn => {
    if (closed) throw new Error(`conversation ${id} is closed`);
    if (commands.destination()) throw new Error(`Session rolled over to ${commands.destination()}`);
    if (active || (completionHeld && !planned?.accepted))
      throw new Error(`conversation ${id} already owns a foreground completion boundary`);
    if (commands.owner && !planned?.accepted) throw new Error('Session history is reserved by a command');
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
    const { input, notice: _notice, submission: _submission, previewMode: _previewMode, ...settings } = request;
    const { notice, modelInput, rawHistory, modelHistory, sentInput } = prepareConversationNotice(
      turnId,
      request,
      planned,
      snapshot.history,
      journal,
      capabilities!,
      generation,
    );
    // Old detached branches keep the exact generation that admitted their root.
    const turnDeps = generation.runtime;
    const turnContinuity = generation.continuity;
    try {
      const runNested = background!.nested(turnDeps, turnId, request.submission?.origin);
      const handle = (planned?.compaction ? startCompaction : startTurn)(
        {
          ...settings,
          turnId,
          history: modelHistory,
          ...(snapshot.compactionState ? { compactionState: snapshot.compactionState } : {}),
          newItems: sentInput,
        },
        {
          ...turnDeps,
          onTurnBoundary: ({ turnId }) => tasks!.releaseParent(turnId),
          budget: runBudgets.open(turnId, undefined, turnDeps.budget),
          continuity: turnContinuity,
          takeSteering: boundary,
          prepareRequest: capabilities!.prepareRequest,
          normalStop: capabilities!.normalStop,
          ...(generation.supplied?.contextMilestones
            ? { contextMilestones: generation.supplied.contextMilestones }
            : {}),
          runNested,
          subagents: background!.subagentPort,
          shellTasks: (parent) => background!.shellTaskPort(parent, request.submission?.origin),
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
  const installGeneration = (
    candidate: DirectPreparedConfiguration,
    prepared: PreparedConversationGeneration,
  ): void => {
    try {
      generation.install(candidate, prepared, capabilities!.replace, (nextRequest) => {
        queueSettings = nextRequest;
      });
    } catch (error) {
      poison(error);
      throw error;
    }
  };
  return {
    id,
    tasks,
    configureTaskCheckIn,
    currentRequest: (fallback) => generation.currentRequest(fallback),
    drainBackgroundNotifications: background.drain,
    cancelCommand: commands.cancel,
    commandRevision: commands.revision,
    rewindTargets: commands.rewindTargets,
    command: commands.command,
    abort: (expectedTurnId, discardQueue = true, returnSteers = false) =>
      abortConversation({
        expectedTurnId,
        discardQueue,
        returnSteers,
        closed,
        active,
        completionHeld,
        facts,
        journal,
        environment: environment(),
      }),
    snapshotInputPreview(request) {
      if (closed || journal.failure) throw new Error(journal.failure?.message ?? 'Session is closed');
      return generation.preview(
        request,
        facts,
        capabilities!,
        !!active ||
          !!completionHeld ||
          !!journal.queueState.active ||
          (!journal.queueState.pause && journal.queueState.pending.length > 0),
        journal.openedAt,
      );
    },
    acceptedHistory: () =>
      replay(facts, { recoverQueue: false, recoverActiveTurn: false, openedAt: journal.openedAt }).history,
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
    submit(request, settings, expectedSteerTurnId) {
      if (
        commands.owner?.kind === 'rollover' ||
        commands.destination() ||
        (completionHeld && directRolloverAtBoundary(facts, completionHeld))
      )
        return {
          admission: {
            kind: 'rejected',
            clientRequestId: request.clientRequestId,
            reason: commands.destination()
              ? `Session rolled over to ${commands.destination()}`
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
      const plan = submitDirectQueue(journal.queueState, request, environment(), expectedSteerTurnId);
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
      if (command.kind === 'settled' && commands.owner) command = { ...command, preservePendingSteers: true };
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
      if (active || commands.owner || closed || journal.failure || commands.destination() || !queueSettings)
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
      background!.stopCheckIns();
      commands.owner?.abort.abort();
      const failures: unknown[] = [];
      await commands.owner?.done?.catch((error) => failures.push(error));
      // A rejected owner must not skip siblings or release the writer while
      // another physical stop is still pending.
      const stopped = await Promise.allSettled([
        Promise.resolve().then(() => active?.stop()),
        Promise.resolve().then(() => tasks!.close()),
      ]);
      for (const result of stopped) if (result.status === 'rejected') failures.push(result.reason);
      try {
        await capabilities!.close(!!journal.failure);
      } catch (error) {
        failures.push(error);
      }
      try {
        deps.log.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 1) throw new AggregateError(failures, 'direct Conversation shutdown and cleanup failed');
      if (failures.length) throw failures[0];
    },
  };
}
