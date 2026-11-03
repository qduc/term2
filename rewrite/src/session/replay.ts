import { planDirectTiming } from './direct-time-gap.js';
/** Pure direct-log projection: no writes, dispatch, provider calls or restored authority. */
import type { TurnId } from '../engine/index.js';
import type { Item } from '../model/index.js';
import type { DirectTaskState } from './direct-background-types.js';
import { reduceDirectCommandReceipts } from './direct-command-receipts.js';
import type { DirectCommandReceipts } from './direct-command-types.js';
import { parseDirectConfigurationFact } from './direct-configuration.js';
import {
  initialDirectContextState,
  isDirectContextFactType,
  parseDirectContextFact,
  reduceDirectContext,
  startsDirectHumanWindow,
  type DirectContextState,
} from './direct-context.js';
import { directPersonalMemoryItem, type DirectMemoryFact } from './direct-memory.js';
import { reduceDirectNotifications, type DirectNotificationState } from './direct-notifications.js';
import { isDirectQueueFactType } from './direct-queue-decode.js';
import { DirectQueueReplay } from './direct-queue-replay.js';
import type { DirectQueueState } from './direct-queue-types.js';
import type { ReplayedConversation as NativeReplayedConversation } from './direct-types.js';
import type { DirectCompactionFact, DirectHistoryFact, Fact, TurnOutcomeName } from './facts.js';
import {
  appendReplayDelta,
  appendReplayItem,
  createActiveReplayTurn,
  finishReplayText,
  hasUnsettledReplayRoots,
  recordReplayStart,
  recoverReplayRoots,
  type ActiveReplayTurn as ActiveTurn,
} from './replay-active-turn.js';
import { ReplayBackground } from './replay-background.js';
import { ReplayRotation } from './replay-rotation.js';

export type ReplayOptions = {
  /** False for live history/root settlement; only explicit reopen recovers/pauses the queue. */
  readonly recoverQueue?: boolean;
  /**
   * False keeps accepted root history. Missing tool results, closures, budget stops,
   * and a terminal are not invented. Busy preview passes false with recoverQueue false.
   */
  readonly recoverActiveTurn?: boolean;
  /** Live means the handle has drained: absent durable admission proves no body ran. */
  readonly rootSettlement?: 'restart' | 'live';
};
/** Accepted evidence only. Missing outcome stays unobserved, even after root recovery. */
export type ReplayedCompaction = {
  readonly start: Extract<DirectCompactionFact, { type: 'compaction_started' }>;
  readonly replacement?: DirectHistoryFact;
  readonly outcome?: Exclude<DirectCompactionFact, { type: 'compaction_started' }>;
};
export type ReplayedBranch = {
  readonly branchId: string;
  readonly taskId: string;
  readonly turnId: TurnId;
  /** Only ancestry explicitly recorded on branch_started; absent on older logs. */
  readonly parentTurnId?: TurnId;
  readonly rootTurnId?: TurnId;
  readonly history: readonly Item[];
  /** This branch's attempts only, joined to its actual branch/task/turn identity above. */
  readonly compactions: readonly ReplayedCompaction[];
  readonly status: 'idle' | 'interrupted';
};
export type ReplayedConversation = NativeReplayedConversation & {
  readonly queue: DirectQueueState;
  readonly context: DirectContextState;
  /** Accepted audit state only; explicit task recovery uses a caller-supplied clock. */
  readonly background: readonly DirectTaskState[];
  /** Accepted receipts only. Session's recoverDirectCommands is the sole pending-command writer. */
  readonly commands: DirectCommandReceipts;
  /** Accepted notices only. A drain admission is the sole delivery writer. */
  readonly notifications: DirectNotificationState;
  readonly branches: readonly ReplayedBranch[];
  /** Root attempts only; never accounting, transcript, or recovery instructions. */
  readonly compactions: readonly ReplayedCompaction[];
  readonly compactionState?: {
    readonly rearmAtEstimatedTokens?: number;
    readonly rearmAtRenderedTokens?: number;
    readonly checkpointReceipts?: readonly string[];
  };
};

type Slot = { item: Item | null };

/**
 * Retains native items in order, with unsuperseded text at its model-step position.
 * Incomplete root occurrences get exactly one known or outcome-unobserved result;
 * nested starts/finishes remain audit only. Recovery facts are returned, not written:
 * Session must append them before the next turn's start, in the supplied order.
 */
export function replay(facts: readonly Fact[], options: ReplayOptions = {}): ReplayedConversation {
  // Open and turn boundaries ask for the same, growing log many times. A log with no active turn and
  // nothing to repair gives the same projection under every option set, so the fold that produced
  // it is kept per facts array (journals only append) and later calls fold just the new facts.
  // A fold that had to apply repairs is consumed by them and dropped.
  const kept = foldCache.get(facts);
  // The options shape the result (queue recovery, root settlement), so a held result is served only to the same options.
  const key = `${options.recoverQueue !== false}|${options.recoverActiveTurn !== false}|${
    options.rootSettlement ?? ''
  }`;
  if (kept && kept.length === facts.length && kept.key === key) return kept.result;
  foldCache.delete(facts); // A fold that throws mid-way must not be resumed.
  const fold = kept && kept.length <= facts.length ? kept.fold : createReplayFold();
  for (let i = kept && kept.fold === fold ? kept.length : 0; i < facts.length; i++) fold.consume(facts[i]!);
  const result = fold.finish(options, options.recoverActiveTurn !== false);
  if (result.status === 'idle' && result.recoveryFacts.length === 0)
    foldCache.set(facts, { fold, length: facts.length, key, result });
  return result;
}
const foldCache = new WeakMap<
  readonly Fact[],
  { fold: ReplayFold; length: number; key: string; result: ReplayedConversation }
>();

function replayProjection(
  facts: readonly Fact[],
  options: ReplayOptions,
  repairActiveTurn: boolean,
): ReplayedConversation {
  const fold = createReplayFold();
  for (const fact of facts) fold.consume(fact);
  return fold.finish(options, repairActiveTurn);
}

/**
 * The fold over accepted facts. `consume` is the only thing that grows with history; `finish` applies the
 * caller's recovery policy and is destructive whenever it has repairs to make, so a fold that finished
 * with repairs must not be fed again.
 */
type ReplayFold = {
  consume(fact: Fact): void;
  finish(options: ReplayOptions, repairActiveTurn: boolean): ReplayedConversation;
};
function createReplayFold(): ReplayFold {
  let slots: Slot[] = [];
  let active: ActiveTurn | null = null;
  const queue = new DirectQueueReplay();
  const backgroundAudit = new ReplayBackground();
  const rotation = new ReplayRotation();
  let context = initialDirectContextState();
  let commandReceipts: DirectCommandReceipts = [];
  const maintenanceCommands = new Set<string>();
  const maintenanceTurns = new Set<TurnId>();
  let notifications: DirectNotificationState = { notices: [], deliveries: [] };
  const noticeDeliveries = new Set<TurnId>();
  const silentTurns = new Set<TurnId>();
  const startedTurns = new Set<TurnId>();
  let lastRootTurnId: TurnId | undefined;
  let compactionState: ReplayedConversation['compactionState'];
  const compactions = new Map<string, ReplayedCompaction>();
  const humanSlots = new Map<string, Slot>();
  const personalSnapshots = new Map<string, Extract<DirectMemoryFact, { type: 'memory_personal_snapshot' }>>();
  const deliveredSnapshots = new Set<string>();
  let sessionId: string | undefined;

  const attachPersonal = (admissionId: string): void => {
    const fact = personalSnapshots.get(admissionId);
    const anchor = humanSlots.get(admissionId);
    if (!fact || !anchor || deliveredSnapshots.has(admissionId)) return;
    const position = slots.indexOf(anchor);
    if (position < 0) return; // An authoritative history replacement already removed this old admission.
    // Match live humanPlan: application data precedes its unchanged human item,
    // including that item's timing metadata. Reordering it on reopen changes the provider prefix.
    slots.splice(position, 0, { item: directPersonalMemoryItem(fact) });
    deliveredSnapshots.add(admissionId);
  };
  const appendHuman = (item: Item): Slot => {
    const slot = { item };
    slots.push(slot);
    if (item.type === 'user_message') {
      humanSlots.set(item.id, slot);
      attachPersonal(item.id);
    }
    return slot;
  };
  let lastOutcome: TurnOutcomeName | null = null;

  const requireActive = (turnId: TurnId, type: string): ActiveTurn => {
    if (active === null) throw new Error(`replay: ${type} for turn ${turnId} without an open turn`);
    if (active.turnId !== turnId) {
      throw new Error(`replay: ${type} for turn ${turnId} while turn ${active.turnId} is open`);
    }
    return active;
  };

  const requireCompaction = (compactionId: string, turnId: TurnId): ReplayedCompaction => {
    const attempt = compactions.get(compactionId);
    if (!attempt || attempt.start.turnId !== turnId) {
      throw new Error(`replay: compaction ${compactionId} has no matching start in this turn/scope`);
    }
    if (attempt.outcome) throw new Error(`replay: compaction ${compactionId} already has an outcome`);
    return attempt;
  };

  const consume = (fact: Fact): void => {
    // Display observations never enter provider slots, admission or lifecycle state.
    if (fact.type === 'transcript_message') return;
    if (fact.type === 'command_started' || fact.type === 'command_finished') {
      // Receipts are not provider history and are not recovered here.
      commandReceipts = reduceDirectCommandReceipts(commandReceipts, fact);
      return;
    }
    if (fact.type === 'background_notice_enqueued' || fact.type === 'background_notices_delivered') {
      if (fact.type === 'background_notices_delivered' && startedTurns.has(fact.turnId)) {
        throw new Error('replay: background notice delivery does not own its turn');
      }
      notifications = reduceDirectNotifications(notifications, fact);
      if (fact.type === 'background_notices_delivered') noticeDeliveries.add(fact.turnId);
      return;
    }
    if (fact.type === 'configuration_changed') {
      // The fact stays accepted audit. Do not prepare a runtime or copy it into provider history.
      if (sessionId === undefined) throw new Error('replay: configuration changed before the Session started');
      if (active) throw new Error('replay: configuration changed during an active turn');
      parseDirectConfigurationFact(fact);
      return;
    }
    if (isDirectQueueFactType(fact.type)) {
      if (fact.type === 'queue_started') rotation.authorizeSeed(fact, queue.state);
      const clock = context.latestHumanInputAt;
      const input = queue.accept(fact, active?.turnId ?? null);
      for (const item of planDirectTiming(clock, queue.state.records, input).modelInput) appendHuman(item);
      // Human steers reset the goal window; automatic steers keep the same reminders.
      if (fact.type === 'queue_steered') context = reduceDirectContext(context, fact, queue.state.records);
      return;
    }
    if (isDirectContextFactType(fact.type)) {
      const accepted = parseDirectContextFact(fact);
      if (accepted.type === 'rollover_requested') {
        // Schema already required the strict request. This is audit, not a successor or a goal reset.
        if (!active || active.turnId !== accepted.turnId || maintenanceTurns.has(accepted.turnId)) {
          throw new Error('replay: rollover request is not the active non-maintenance root');
        }
        rotation.request(accepted.turnId);
        return;
      }
      if (accepted.type === 'session_rotated') {
        rotation.accept(accepted, active !== null, sessionId, commandReceipts);
        // Drop root provider context only. Tasks, queue, goal, notifications, and costs stay.
        slots = [];
        compactionState = undefined;
        lastRootTurnId = undefined;
        humanSlots.clear();
        return;
      }
      context = reduceDirectContext(context, accepted, queue.state.records);
      if (accepted.type === 'memory_personal_snapshot') {
        if (personalSnapshots.has(accepted.admissionId))
          throw new Error('replay: duplicate personal snapshot admission');
        personalSnapshots.set(accepted.admissionId, accepted);
        attachPersonal(accepted.admissionId);
      }
      return;
    }
    if (backgroundAudit.accept(fact)) return;
    queue.accept(fact, active?.turnId ?? null);
    const clock = context.latestHumanInputAt;
    context = reduceDirectContext(context, fact, queue.state.records);
    switch (fact.type) {
      case 'session_started':
        if (sessionId && sessionId !== fact.id) throw new Error('replay: conflicting Session identity');
        sessionId = fact.id;
        break;
      case 'turn_started': {
        if (active !== null) {
          throw new Error(`replay: turn ${fact.turnId} started while turn ${active.turnId} has no turn_ended`);
        }
        if (fact.silent && fact.retryContext) throw new Error('replay: a turn cannot be both silent and a retry');
        if (noticeDeliveries.has(fact.turnId) && !fact.silent) {
          throw new Error('replay: background notice delivery is not a silent turn');
        }
        lastOutcome = null;
        if (rotation.start(fact)) {
          for (const item of fact.input) slots.push({ item });
        } else if (fact.maintenance) {
          // Compaction is an empty root owned by one pending compact command. It contributes no user transcript.
          if (fact.submission || fact.silent || fact.retryContext || fact.input.length !== 0) {
            throw new Error('replay: maintenance is not a human, silent, or retry admission');
          }
          const commandId = fact.maintenance.commandId;
          if (maintenanceCommands.has(commandId)) throw new Error('replay: compaction command already admitted a root');
          const receipt = commandReceipts.find((item) => item.request.commandId === commandId);
          if (!receipt || receipt.outcome !== undefined || receipt.request.operation.kind !== 'compact') {
            throw new Error('replay: compaction maintenance has no pending compact command');
          }
          maintenanceCommands.add(commandId);
          maintenanceTurns.add(fact.turnId);
        } else if (fact.retryContext) {
          // Continuation reuses the replacement history. Do not readmit its source input or memory.
          if (fact.submission || fact.input.length !== 0) throw new Error('replay: retry is not a new admission');
          if (lastRootTurnId === undefined || fact.retryContext.sourceTurnId !== lastRootTurnId) {
            throw new Error('replay: retry source is not the prior root turn');
          }
          const endpoint = slots.at(-1)?.item;
          if (!endpoint || endpoint.id !== fact.retryContext.throughItemId) {
            throw new Error('replay: retry endpoint is not the retained history endpoint');
          }
        } else if (fact.silent) {
          if (fact.submission || !noticeDeliveries.has(fact.turnId)) {
            throw new Error('replay: silent turn is not a delivered background notice');
          }
          if (fact.input.length === 0) throw new Error('replay: silent turn has no planning input');
          // Planning input is provider context, not a human admission, so it does not anchor memory.
          for (const item of fact.input) slots.push({ item });
          silentTurns.add(fact.turnId);
        } else {
          let lastHuman: Slot | undefined;
          const input = startsDirectHumanWindow(fact, queue.state.records)
            ? planDirectTiming(clock, queue.state.records, fact.input).modelInput
            : fact.input;
          for (const item of input) {
            const slot = appendHuman(item);
            if (item.type === 'user_message') lastHuman = slot;
          }
          if (lastHuman) {
            humanSlots.set(fact.turnId, lastHuman);
            attachPersonal(fact.turnId);
          }
        }
        startedTurns.add(fact.turnId);
        lastRootTurnId = fact.turnId;
        active = createActiveReplayTurn(fact.turnId);
        break;
      }
      case 'text_delta': {
        const turn = requireActive(fact.turnId, fact.type);
        appendReplayDelta(turn, fact, slots);
        break;
      }
      case 'item':
        appendReplayItem(requireActive(fact.turnId, fact.type), fact, slots);
        break;
      case 'tool_started':
        recordReplayStart(requireActive(fact.turnId, fact.type), fact);
        break;
      case 'tool_finished': {
        const turn = requireActive(fact.turnId, fact.type);
        const execution = turn.executions.get(fact.executionId);
        if (!execution?.start) throw new Error(`replay: finish without start for ${fact.executionId}`);
        if (execution.result) throw new Error(`replay: duplicate finish for ${fact.executionId}`);
        execution.result = fact.result;
        break;
      }
      case 'interaction_opened': {
        const turn = requireActive(fact.turnId, fact.type);
        const { request } = fact;
        if (request.turnId !== turn.turnId) throw new Error(`replay: interaction ${request.requestId} has wrong turn`);
        if (turn.interactions.has(request.requestId) || turn.closedInteractions.has(request.requestId)) {
          throw new Error(`replay: duplicate interaction ${request.requestId}`);
        }
        turn.interactions.set(request.requestId, fact);
        break;
      }
      case 'interaction_closed': {
        const turn = requireActive(fact.turnId, fact.type);
        if (!turn.interactions.delete(fact.requestId)) {
          throw new Error(`replay: closure without open interaction ${fact.requestId}`);
        }
        turn.closedInteractions.add(fact.requestId);
        break;
      }
      case 'budget_opened': {
        const turn = requireActive(fact.turnId, fact.type);
        if (turn.budgets.has(fact.requestId) || turn.closedBudgets.has(fact.requestId))
          throw new Error(`replay: duplicate budget wait ${fact.requestId}`);
        turn.budgets.set(fact.requestId, fact);
        break;
      }
      case 'budget_closed': {
        const turn = requireActive(fact.turnId, fact.type);
        if (!turn.budgets.delete(fact.requestId))
          throw new Error(`replay: closure without open budget wait ${fact.requestId}`);
        turn.closedBudgets.add(fact.requestId);
        break;
      }
      case 'budget_observed':
        requireActive(fact.turnId, fact.type);
        break;
      case 'usage':
        requireActive(fact.turnId, fact.type);
        break;
      case 'compaction_started':
        requireActive(fact.turnId, fact.type);
        if (compactions.has(fact.compactionId)) throw new Error('replay: duplicate compaction start');
        compactions.set(fact.compactionId, { start: fact });
        break;
      case 'compaction_completed':
      case 'compaction_failed': {
        requireActive(fact.turnId, fact.type);
        const attempt = requireCompaction(fact.compactionId, fact.turnId);
        if (fact.type === 'compaction_completed' && !attempt.replacement)
          throw new Error('replay: compaction completed without its accepted history replacement');
        if (fact.type === 'compaction_failed' && attempt.replacement)
          throw new Error('replay: compaction failed after its accepted history replacement');
        compactions.set(fact.compactionId, { ...attempt, outcome: fact });
        // Requests are references to physical accounting, not another charge or response receipt.
        break;
      }
      case 'history_replaced': {
        if (fact.compactionId !== undefined) {
          if (fact.reason !== 'compaction' || fact.turnId === undefined)
            throw new Error('replay: compaction replacement has no owning compaction turn');
          const attempt = requireCompaction(fact.compactionId, fact.turnId);
          if (attempt.replacement) throw new Error('replay: duplicate compaction replacement');
          compactions.set(fact.compactionId, { ...attempt, replacement: fact });
        }
        if (fact.turnId !== undefined) {
          const turn = requireActive(fact.turnId, fact.type);
          if (hasUnsettledReplayRoots(turn))
            throw new Error('replay: history replacement has unsettled physical tool debt');
          turn.partials.clear();
        } else if (active) throw new Error('replay: session-wide history replacement during an active turn');
        slots = fact.history.map((item) => ({ item }));
        compactionState =
          fact.reason === 'compaction'
            ? {
                ...(fact.rearmAtEstimatedTokens === undefined
                  ? {}
                  : { rearmAtEstimatedTokens: fact.rearmAtEstimatedTokens }),
                ...(fact.rearmAtRenderedTokens === undefined
                  ? {}
                  : { rearmAtRenderedTokens: fact.rearmAtRenderedTokens }),
                ...(fact.checkpointReceipts === undefined ? {} : { checkpointReceipts: fact.checkpointReceipts }),
              }
            : undefined;
        break;
      }
      case 'model_response_completed': {
        const turn = requireActive(fact.turnId, fact.type);
        if (turn.responses.has(fact.modelStep)) throw new Error('replay: duplicate model response receipt');
        turn.responses.add(fact.modelStep);
        break;
      }
      case 'turn_ended': {
        const turn = requireActive(fact.turnId, fact.type);
        if (
          fact.finalWindow &&
          (fact.finalWindow.turnId !== fact.turnId || fact.finalWindow.record.terminalCause !== fact.terminalCause)
        ) {
          throw new Error('replay: final window does not match its terminal');
        }
        // Repairs belong before the terminal, never appended behind a closed turn.
        if (hasUnsettledReplayRoots(turn) || turn.interactions.size !== 0 || turn.budgets.size !== 0) {
          throw new Error(`replay: turn ${turn.turnId} ended with unsettled calls, interactions or budget waits`);
        }
        finishReplayText(turn);
        active = null;
        lastOutcome = fact.outcome;
        break;
      }
      default: {
        const type: unknown = (fact as { type?: unknown }).type;
        throw new Error(`replay: unknown fact type ${JSON.stringify(String(type))}`);
      }
    }
  };

  const finish = (options: ReplayOptions, repairActiveTurn: boolean): ReplayedConversation => {
    const recoveryFacts: Fact[] = []; // fresh per call: earlier results are held by callers and the cache
    if (options.recoverQueue !== false) {
      const start = queue.missingStart();
      if (start) {
        recoveryFacts.push(start);
        consume(start);
      }
    }
    // A closure-mutated active turn is read through a function so TS does not
    // mistake the initial null for a lifetime invariant.
    const unfinished = (): ActiveTurn | null => active;
    const turn = unfinished();
    if (turn && repairActiveTurn) {
      const repairs: Fact[] = [...recoverReplayRoots(turn, options.rootSettlement)];
      for (const { request } of turn.interactions.values())
        repairs.push({
          type: 'interaction_closed',
          turnId: turn.turnId,
          requestId: request.requestId,
          resolution: { kind: 'interrupted' },
        });
      for (const { requestId } of turn.budgets.values())
        repairs.push({
          type: 'budget_closed',
          turnId: turn.turnId,
          requestId,
          decision: { kind: 'stop' },
          source: 'system',
        });
      repairs.push({ type: 'turn_ended', turnId: turn.turnId, outcome: 'interrupted' });
      for (const fact of repairs) {
        recoveryFacts.push(fact);
        consume(fact);
      }
    }
    if (turn && !repairActiveTurn) finishReplayText(turn);
    if (options.recoverQueue !== false) {
      recoveryFacts.push(...queue.reconcileTerminal(), ...queue.pausePending());
    }
    rotation.assertComplete();
    for (const turnId of noticeDeliveries) {
      if (!silentTurns.has(turnId)) throw new Error('replay: background notice delivery has no silent turn');
    }
    const background = backgroundAudit.project(sessionId, (branchFacts) =>
      replayProjection(branchFacts, { recoverQueue: false }, options.recoverQueue !== false),
    );
    recoveryFacts.push(...background.recoveryFacts);
    return {
      status: unfinished() !== null || lastOutcome === 'interrupted' ? 'interrupted' : 'idle',
      history: slots.flatMap(({ item }) => (item === null ? [] : [item])),
      nextTurn: queue.nextTurn,
      recoveryFacts,
      queue: queue.state,
      context,
      background: background.background,
      commands: commandReceipts,
      notifications,
      branches: background.branches,
      compactions: [...compactions.values()],
      ...(compactionState ? { compactionState } : {}),
    };
  };
  return { consume, finish };
}
