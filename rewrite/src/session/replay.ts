/** Pure direct-log projection: no writes, dispatch, provider calls or restored authority. */
import type { Item, ItemId } from '../model/index.js';
import type { ExecutionId, TurnId } from '../engine/index.js';
import type { ToolResult } from '../tools/index.js';
import type { ReplayedConversation as NativeReplayedConversation } from './direct-types.js';
import { DirectQueueReplay } from './direct-queue-replay.js';
import { isDirectQueueFactType } from './direct-queue-decode.js';
import {
  initialDirectContextState,
  isDirectContextFactType,
  parseDirectContextFact,
  reduceDirectContext,
  type DirectContextState,
} from './direct-context.js';
import { directPersonalMemoryItem, type DirectMemoryFact } from './direct-memory.js';
import { projectDirectBackground } from './direct-background-replay.js';
import type { DirectBackgroundFact, DirectTaskState } from './direct-background-types.js';
import type { DirectQueueState } from './direct-queue-types.js';
import type { Fact, TurnOutcomeName, DirectTurnFact } from './facts.js';
import { isDirectCommandFactType, reduceDirectCommandReceipts } from './direct-command-receipts.js';
import type { DirectCommandReceipts } from './direct-command-types.js';
import {
  isDirectNotificationFactType,
  reduceDirectNotifications,
  type DirectNotificationState,
} from './direct-notifications.js';
import { parseDirectConfigurationFact } from './direct-configuration.js';

export type ReplayOptions = {
  /** False for live history/root settlement; only explicit reopen recovers/pauses the queue. */
  readonly recoverQueue?: boolean;
  /**
   * False keeps accepted root history. Missing tool results, closures, budget stops,
   * and a terminal are not invented. Busy preview passes false with recoverQueue false.
   */
  readonly recoverActiveTurn?: boolean;
};
export type ReplayedBranch = {
  readonly branchId: string;
  readonly taskId: string;
  readonly turnId: TurnId;
  /** Only ancestry explicitly recorded on branch_started; absent on older logs. */
  readonly parentTurnId?: TurnId;
  readonly rootTurnId?: TurnId;
  readonly history: readonly Item[];
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
  readonly compactionState?: {
    readonly rearmAtEstimatedTokens?: number;
    readonly checkpointReceipts?: readonly string[];
  };
};

// Kept local to the direct path: importing the old ledger would load the legacy runtime.
const OUTCOME_UNOBSERVED =
  "Outcome unobserved: the session restarted before this operation's result was recorded. " +
  'Its effect may or may not have occurred. Verify the current state before any retry, and ' +
  'do not re-run non-idempotent operations blindly.';

type Call = Extract<Item, { type: 'tool_call' }>;
type Start = Extract<Fact, { type: 'tool_started' }>;
type RequestCost = Extract<Fact, { type: 'request_cost_recorded' }>;
type BranchStream = {
  readonly taskId: string;
  readonly turnId: TurnId;
  readonly parentTurnId?: TurnId;
  readonly rootTurnId?: TurnId;
  readonly facts: (Extract<Fact, { type: 'turn_started' }> | Extract<Fact, { type: 'branch_event' }>['fact'])[];
};
type Slot = { item: Item | null };
type Partial = { readonly slot: Slot; readonly deltas: string[]; readonly id: ItemId };
type Occurrence = {
  readonly call: Call;
  /** Legacy calls use their position, never a provider ID or argument hash, as identity. */
  readonly key: string;
  executionId?: ExecutionId;
  settled: boolean;
};
type Execution = { start?: Start; result?: ToolResult; occurrence?: Occurrence };
type ActiveTurn = {
  readonly turnId: TurnId;
  readonly partials: Map<number | undefined, Partial>;
  readonly calls: Occurrence[];
  readonly executions: Map<ExecutionId, Execution>;
  readonly interactions: Map<string, Extract<Fact, { type: 'interaction_opened' }>>;
  readonly closedInteractions: Set<string>;
  readonly responses: Set<number>;
  readonly budgets: Map<string, Extract<Fact, { type: 'budget_opened' }>>;
  readonly closedBudgets: Set<string>;
};

/**
 * Retains native items in order, with unsuperseded text at its model-step position.
 * Incomplete root occurrences get exactly one known or outcome-unobserved result;
 * nested starts/finishes remain audit only. Recovery facts are returned, not written:
 * Session must append them before the next turn's start, in the supplied order.
 */
export function replay(facts: readonly Fact[], options: ReplayOptions = {}): ReplayedConversation {
  return replayProjection(facts, options, options.recoverActiveTurn !== false);
}

function replayProjection(
  facts: readonly Fact[],
  options: ReplayOptions,
  repairActiveTurn: boolean,
): ReplayedConversation {
  let slots: Slot[] = [];
  const recoveryFacts: Fact[] = [];
  let active: ActiveTurn | null = null;
  const queue = new DirectQueueReplay();
  let context = initialDirectContextState();
  const backgroundFacts: DirectBackgroundFact[] = [];
  const branches = new Map<string, BranchStream>();
  let commandReceipts: DirectCommandReceipts = [];
  const maintenanceCommands = new Set<string>();
  const maintenanceTurns = new Set<TurnId>();
  const rolloverTurns = new Set<TurnId>();
  const rotationCommands = new Set<string>();
  let rolloverSeed:
    | {
        readonly commandId: string;
        readonly clientRequestId: string;
        readonly messageId: string;
        readonly turnId: TurnId;
        seeded: boolean;
        started: boolean;
      }
    | undefined;
  let notifications: DirectNotificationState = { notices: [], deliveries: [] };
  const noticeDeliveries = new Set<TurnId>();
  const silentTurns = new Set<TurnId>();
  const startedTurns = new Set<TurnId>();
  let lastRootTurnId: TurnId | undefined;
  // Accounting outlives transcript replacements/terminals. Only ownership is immutable;
  // a later physical receipt may correct or enrich the same request's record.
  const requestCosts = new Map<string, RequestCost>();
  let compactionState: ReplayedConversation['compactionState'];
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
    slots.splice(position + 1, 0, { item: directPersonalMemoryItem(fact) });
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

  const appendItem = (turn: ActiveTurn, fact: Extract<Fact, { type: 'item' }>): void => {
    const { item, executionId } = fact;
    if (item.type === 'assistant_message') {
      // A complete item supersedes only its own step's pending text, not an earlier response.
      const partial = turn.partials.get(fact.modelStep);
      if (partial) partial.slot.item = null;
      turn.partials.delete(fact.modelStep);
    }
    if (item.type === 'tool_call') recordCall(turn, item, executionId);
    else if (item.type === 'tool_result') recordResult(turn, item, executionId);
    else if (executionId !== undefined) {
      throw new Error(`replay: executionId on non-tool item ${item.id}`);
    }
    slots.push({ item });
  };

  const finishText = (turn: ActiveTurn): void => {
    for (const partial of turn.partials.values()) {
      partial.slot.item = {
        type: 'assistant_message',
        id: partial.id,
        content: [{ type: 'text', text: partial.deltas.join('') }],
      };
    }
  };

  const controlHandoff = (
    origin: { readonly kind?: string; readonly id?: string; readonly source?: string } | undefined,
  ): boolean => origin?.kind === 'control' && origin.id === 'session-rollover' && origin.source === undefined;

  const authorizeRolloverSeed = (fact: Extract<Fact, { type: 'queue_started' }>): void => {
    if (!('rolloverCommandId' in fact)) {
      if (rolloverSeed && !rolloverSeed.started && fact.messageId === rolloverSeed.messageId) {
        throw new Error('replay: rollover handoff started without its command marker');
      }
      return;
    }
    const marker = fact.rolloverCommandId;
    if (typeof marker !== 'string' || marker.length === 0) throw new Error('replay: rollover seed command id is empty');
    if (!rolloverSeed || rolloverSeed.seeded || marker !== rolloverSeed.commandId) {
      throw new Error('replay: rollover seed is not the current rotation');
    }
    if (fact.messageId !== rolloverSeed.messageId || fact.turnId !== rolloverSeed.turnId) {
      throw new Error('replay: rollover seed does not match the rotation handoff');
    }
    const record = queue.state.records.find((item) => item.messageId === fact.messageId);
    if (
      !record ||
      record.stage !== 'queued' ||
      record.admission.kind !== 'queued' ||
      record.admission.turnId !== fact.turnId ||
      record.turnId !== fact.turnId ||
      record.request.delivery !== 'follow_up' ||
      record.request.clientRequestId !== rolloverSeed.clientRequestId ||
      !controlHandoff(record.request.origin)
    ) {
      throw new Error('replay: rollover seed is not the admitted control handoff');
    }
    rolloverSeed.seeded = true;
  };

  const acceptRotation = (fact: Extract<Fact, { type: 'session_rotated' }>): void => {
    if (active) throw new Error('replay: session rotated during an active root');
    if (!sessionId || fact.logicalSessionId !== sessionId) {
      throw new Error('replay: rotation logical id is not the original Session');
    }
    if (rolloverSeed && !rolloverSeed.started) throw new Error('replay: previous rotation handoff was not started');
    const receipt = commandReceipts.find((item) => item.request.commandId === fact.commandId);
    if (!receipt || receipt.outcome !== undefined || receipt.request.operation.kind !== 'rollover') {
      throw new Error('replay: rotation has no pending rollover command');
    }
    if (rotationCommands.has(fact.commandId)) throw new Error('replay: rollover command already rotated');
    rotationCommands.add(fact.commandId);
    // Drop root provider context only. Tasks, queue, goal, notifications, and costs stay.
    slots = [];
    compactionState = undefined;
    lastRootTurnId = undefined;
    humanSlots.clear();
    rolloverSeed = fact.handoff
      ? {
          commandId: fact.commandId,
          clientRequestId: fact.handoff.clientRequestId,
          messageId: fact.handoff.messageId,
          turnId: fact.handoff.turnId,
          seeded: false,
          started: false,
        }
      : undefined;
  };

  const consume = (fact: Fact): void => {
    if (isDirectCommandFactType(fact.type)) {
      // Receipts are not provider history and are not recovered here.
      commandReceipts = reduceDirectCommandReceipts(commandReceipts, fact);
      return;
    }
    if (isDirectNotificationFactType(fact.type)) {
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
      if (fact.type === 'queue_started') authorizeRolloverSeed(fact);
      for (const item of queue.accept(fact, active?.turnId ?? null)) appendHuman(item);
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
        if (rolloverTurns.has(accepted.turnId)) throw new Error('replay: root already requested rollover');
        rolloverTurns.add(accepted.turnId);
        return;
      }
      if (accepted.type === 'session_rotated') {
        acceptRotation(accepted);
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
    if (
      [
        'task_started',
        'task_backgrounded',
        'task_stop_requested',
        'task_finished',
        'task_interaction_opened',
        'task_interaction_closed',
      ].includes(fact.type)
    ) {
      // The decoder recognizes exactly six task variants; projection rejects invalid transitions.
      backgroundFacts.push(fact as DirectBackgroundFact);
      return;
    }
    queue.accept(fact, active?.turnId ?? null);
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
        if (rolloverSeed?.seeded && !rolloverSeed.started) {
          // The handoff is provider context for the new physical log, not a human admission.
          if (
            fact.turnId !== rolloverSeed.turnId ||
            fact.maintenance ||
            fact.silent ||
            fact.retryContext ||
            !controlHandoff(fact.submission?.origin) ||
            fact.submission?.clientRequestId !== rolloverSeed.clientRequestId ||
            fact.submission?.messageId !== rolloverSeed.messageId
          ) {
            throw new Error('replay: rollover handoff turn does not match its admission');
          }
          for (const item of fact.input) slots.push({ item });
          rolloverSeed.started = true;
        } else if (rolloverSeed && !rolloverSeed.started) {
          throw new Error('replay: rotation handoff started before its priority seed');
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
          for (const item of fact.input) {
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
        active = {
          turnId: fact.turnId,
          partials: new Map(),
          calls: [],
          executions: new Map(),
          interactions: new Map(),
          closedInteractions: new Set(),
          responses: new Set(),
          budgets: new Map(),
          closedBudgets: new Set(),
        };
        break;
      }
      case 'text_delta': {
        const turn = requireActive(fact.turnId, fact.type);
        if (fact.delta.length === 0) break;
        let partial = turn.partials.get(fact.modelStep);
        if (!partial) {
          // Preserve M1's ID for untagged partial text.
          const step = fact.modelStep === undefined ? '' : `-model-${fact.modelStep}`;
          partial = { slot: { item: null }, deltas: [], id: `${turn.turnId}${step}-partial` as ItemId };
          turn.partials.set(fact.modelStep, partial);
          slots.push(partial.slot);
        }
        partial.deltas.push(fact.delta);
        break;
      }
      case 'item':
        appendItem(requireActive(fact.turnId, fact.type), fact);
        break;
      case 'tool_started':
        recordStart(requireActive(fact.turnId, fact.type), fact);
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
      case 'history_replaced': {
        if (fact.turnId !== undefined) {
          const turn = requireActive(fact.turnId, fact.type);
          if (hasUnsettledRoots(turn)) throw new Error('replay: history replacement has unsettled physical tool debt');
          turn.partials.clear();
        } else if (active) throw new Error('replay: session-wide history replacement during an active turn');
        slots = fact.history.map((item) => ({ item }));
        compactionState =
          fact.reason === 'compaction'
            ? {
                ...(fact.rearmAtEstimatedTokens === undefined
                  ? {}
                  : { rearmAtEstimatedTokens: fact.rearmAtEstimatedTokens }),
                ...(fact.checkpointReceipts === undefined ? {} : { checkpointReceipts: fact.checkpointReceipts }),
              }
            : undefined;
        break;
      }
      case 'request_cost_recorded': {
        const previous = requestCosts.get(fact.record.requestId);
        if (
          previous &&
          (previous.turnId !== fact.turnId ||
            previous.rootTurnId !== fact.rootTurnId ||
            previous.parentTurnId !== fact.parentTurnId)
        )
          throw new Error(`replay: request cost ownership changed for ${fact.record.requestId}`);
        for (const branch of branches.values()) if (branch.turnId === fact.turnId) validateCostAncestry(fact, branch);
        requestCosts.set(fact.record.requestId, fact);
        // No requireActive: summary/failure/cancel receipts can arrive after a root
        // terminal. Costs are not model-output receipts, usage events or Items.
        break;
      }
      case 'model_response_completed': {
        const turn = requireActive(fact.turnId, fact.type);
        if (turn.responses.has(fact.modelStep)) throw new Error('replay: duplicate model response receipt');
        turn.responses.add(fact.modelStep);
        break;
      }
      case 'branch_started':
        if (branches.has(fact.branchId)) throw new Error('replay: duplicate branch ID');
        if (
          !backgroundFacts.some((item) => item.type === 'task_started' && item.task.taskId === fact.taskId) ||
          backgroundFacts.some((item) => item.type === 'task_finished' && item.taskId === fact.taskId)
        )
          throw new Error('replay: branch has no live task owner');
        for (const cost of requestCosts.values()) if (cost.turnId === fact.turnId) validateCostAncestry(cost, fact);
        branches.set(fact.branchId, {
          taskId: fact.taskId,
          turnId: fact.turnId,
          ...(fact.parentTurnId === undefined ? {} : { parentTurnId: fact.parentTurnId }),
          ...(fact.rootTurnId === undefined ? {} : { rootTurnId: fact.rootTurnId }),
          facts: [{ type: 'turn_started', turnId: fact.turnId, input: fact.input }],
        });
        break;
      case 'branch_event': {
        const branch = branches.get(fact.branchId);
        if (!branch || fact.fact.turnId !== branch.turnId)
          throw new Error('replay: branch event has no matching branch turn');
        branch.facts.push(fact.fact);
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
        if (hasUnsettledRoots(turn) || turn.interactions.size !== 0 || turn.budgets.size !== 0) {
          throw new Error(`replay: turn ${turn.turnId} ended with unsettled calls, interactions or budget waits`);
        }
        finishText(turn);
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

  for (const fact of facts) consume(fact);
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
    const repairs: Fact[] = [...recoverRoots(turn)];
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
  if (turn && !repairActiveTurn) finishText(turn);
  if (options.recoverQueue !== false) {
    recoveryFacts.push(...queue.reconcileTerminal(), ...queue.pausePending());
  }
  if (rolloverSeed && !rolloverSeed.started) throw new Error('replay: rotation handoff was not started');
  for (const turnId of noticeDeliveries) {
    if (!silentTurns.has(turnId)) throw new Error('replay: background notice delivery has no silent turn');
  }
  const background = projectDirectBackground(backgroundFacts);
  if (sessionId && background.some((task) => task.sessionId !== sessionId))
    throw new Error('replay: task belongs to a different Session');
  const branchViews: ReplayedBranch[] = [];
  for (const [branchId, branch] of branches) {
    // Foreground live settlement must never close a still-productive background branch.
    const view = replayProjection(branch.facts, { recoverQueue: false }, options.recoverQueue !== false);
    branchViews.push({
      branchId,
      taskId: branch.taskId,
      turnId: branch.turnId,
      ...(branch.parentTurnId === undefined ? {} : { parentTurnId: branch.parentTurnId }),
      ...(branch.rootTurnId === undefined ? {} : { rootTurnId: branch.rootTurnId }),
      history: view.history,
      status: view.status,
    });
    if (
      !branch.facts.some((fact) => fact.type === 'turn_ended') &&
      background.some((task) => task.taskId === branch.taskId && task.result)
    )
      throw new Error('replay: task settled before its branch terminal');
    for (const fact of view.recoveryFacts)
      recoveryFacts.push({
        type: 'branch_event',
        branchId,
        fact: fact as Exclude<DirectTurnFact, { type: 'turn_started' | 'interaction_opened' | 'interaction_closed' }>,
      });
  }
  return {
    status: unfinished() !== null || lastOutcome === 'interrupted' ? 'interrupted' : 'idle',
    history: slots.flatMap(({ item }) => (item === null ? [] : [item])),
    nextTurn: queue.nextTurn,
    recoveryFacts,
    queue: queue.state,
    context,
    background,
    commands: commandReceipts,
    notifications,
    branches: branchViews,
    ...(compactionState ? { compactionState } : {}),
  };
}

function recordCall(turn: ActiveTurn, call: Call, executionId?: ExecutionId): void {
  const occurrence: Occurrence = {
    call,
    key: `${turn.turnId}:legacy:${turn.calls.length + 1}`,
    executionId,
    settled: false,
  };
  if (executionId !== undefined) {
    const execution = turn.executions.get(executionId) ?? {};
    if (execution.occurrence) throw new Error(`replay: duplicate call for ${executionId}`);
    if (execution.start) validateRootCall(execution.start, call);
    execution.occurrence = occurrence;
    turn.executions.set(executionId, execution);
  }
  turn.calls.push(occurrence);
}

function recordResult(
  turn: ActiveTurn,
  result: Extract<Item, { type: 'tool_result' }>,
  executionId?: ExecutionId,
): void {
  const occurrence =
    executionId === undefined
      ? turn.calls.find((call) => !call.settled && call.call.callId === result.callId)
      : turn.executions.get(executionId)?.occurrence;
  if (!occurrence || occurrence.settled || occurrence.call.callId !== result.callId) {
    throw new Error(`replay: unmatched or duplicate result for ${executionId ?? result.callId}`);
  }
  occurrence.settled = true;
}

function validateRootCall(start: Start, call: Call): void {
  if (start.parentExecutionId !== undefined) {
    throw new Error(`replay: nested execution ${start.executionId} cannot be a provider root call`);
  }
  if (start.callId !== call.callId || start.toolName !== call.toolName) {
    throw new Error(`replay: start/call mismatch for ${start.executionId}`);
  }
}

function recordStart(turn: ActiveTurn, start: Start): void {
  const execution = turn.executions.get(start.executionId) ?? {};
  if (execution.start) throw new Error(`replay: duplicate start for ${start.executionId}`);
  if (start.parentExecutionId !== undefined) {
    if (!turn.executions.get(start.parentExecutionId)?.start) {
      throw new Error(`replay: missing parent start for ${start.executionId}`);
    }
    if (execution.occurrence) validateRootCall(start, execution.occurrence.call);
  } else {
    // Untagged v1 items pair FIFO by call ID; repeated IDs remain distinct occurrences.
    const occurrence =
      execution.occurrence ??
      turn.calls.find(
        (call) =>
          call.executionId === undefined &&
          !call.settled &&
          call.call.callId === start.callId &&
          call.call.toolName === start.toolName,
      );
    if (occurrence) {
      validateRootCall(start, occurrence.call);
      occurrence.executionId = start.executionId;
      execution.occurrence = occurrence;
    }
  }
  execution.start = start;
  turn.executions.set(start.executionId, execution);
}

function hasUnsettledRoots(turn: ActiveTurn): boolean {
  return (
    turn.calls.some((call) => !call.settled) ||
    [...turn.executions.values()].some(
      (execution) => execution.start && execution.start.parentExecutionId === undefined && !execution.occurrence,
    )
  );
}

/** Missing physical terminals are never invented; nested audit remains outcome-unknown. */
function recoverRoots(turn: ActiveTurn): Fact[] {
  const facts: Fact[] = [];
  const occurrences = [...turn.calls];
  // A root start contains enough evidence to restore its call if publication was interrupted.
  // Child starts deliberately do not: they must never become extra provider calls.
  for (const [executionId, execution] of turn.executions) {
    const start = execution.start;
    if (!start || start.parentExecutionId !== undefined || execution.occurrence) continue;
    const call: Call = {
      type: 'tool_call',
      id: `${executionId}:call` as ItemId,
      callId: start.callId as Call['callId'],
      toolName: start.toolName,
      input: start.input,
    };
    occurrences.push({ call, key: `${executionId}:recovery`, executionId, settled: false });
    facts.push({ type: 'item', turnId: turn.turnId, executionId, item: call });
  }
  for (const occurrence of occurrences) {
    if (occurrence.settled) continue;
    const { executionId, call } = occurrence;
    const known = executionId === undefined ? undefined : turn.executions.get(executionId)?.result;
    const item: Item = {
      type: 'tool_result',
      id: `${executionId ?? occurrence.key}:result` as ItemId,
      callId: call.callId,
      output: known?.output ?? OUTCOME_UNOBSERVED,
      isError: known?.isError ?? true,
      ...(known?.providerOutput === undefined ? {} : { providerOutput: known.providerOutput }),
      ...(call.toolType === undefined ? {} : { toolType: call.toolType }),
    };
    facts.push({ type: 'item', turnId: turn.turnId, item, ...(executionId === undefined ? {} : { executionId }) });
  }
  return facts;
}

/** Older branch records have no ancestry: never infer their root from current foreground activity. */
function validateCostAncestry(
  cost: RequestCost,
  branch: { readonly parentTurnId?: TurnId; readonly rootTurnId?: TurnId },
): void {
  if (
    (branch.parentTurnId !== undefined && branch.parentTurnId !== cost.parentTurnId) ||
    (branch.rootTurnId !== undefined && branch.rootTurnId !== cost.rootTurnId)
  )
    throw new Error(`replay: request cost ancestry disagrees with branch for ${cost.record.requestId}`);
}
