/**
 * The one place that says how an accepted fact is folded into the shared leaf projections (command receipts,
 * notifications, goal/context, queue, background tasks) and in what order. Every projection of the log (live
 * journal, replay, public state, history capture, wire projection) calls this; a rule in
 * rewrite/scripts/check-rules.mjs fails any other module that imports a leaf reducer.
 *
 * A state carries only the slices its caller needs; absent slices are not folded. Order: notification and
 * command facts touch only their own slice; any other fact folds context (which reads the queue records as they
 * were before the fact), then queue, then tasks. Queue records keep origin and content across stages, so a
 * caller that has already applied the queue step itself may pass `queueRecords` instead of a `queue` slice.
 */
import type { DirectTaskState } from './direct-background-types.js';
import { reduceDirectBackground } from './direct-background-replay.js';
import { isDirectCommandFactType, reduceDirectCommandReceipts } from './direct-command-receipts.js';
import type { DirectCommandFact, DirectCommandReceipts } from './direct-command-types.js';
import { reduceDirectContext, type DirectContextState } from './direct-context.js';
import { isDirectNotificationFactType, reduceDirectNotifications } from './direct-notifications.js';
import type { DirectNotificationFact, DirectNotificationState } from './direct-notifications.js';
import { reduceDirectQueue } from './direct-queue-state.js';
import type { DirectQueueRecord, DirectQueueState } from './direct-queue-types.js';
import { isDirectQueueFact, isDirectTaskFact, type Fact } from './facts.js';

export interface FoldState {
  readonly commands?: DirectCommandReceipts;
  readonly notifications?: DirectNotificationState;
  readonly context?: DirectContextState;
  readonly queue?: DirectQueueState;
  readonly tasks?: readonly DirectTaskState[];
  readonly queueRecords?: readonly DirectQueueRecord[];
}

export function foldFact<S extends FoldState>(state: S, fact: Fact): S {
  if (isDirectNotificationFactType(fact.type)) {
    if (!state.notifications) return state;
    return { ...state, notifications: reduceDirectNotifications(state.notifications, fact as DirectNotificationFact) };
  }
  if (isDirectCommandFactType(fact.type)) {
    if (!state.commands) return state;
    return { ...state, commands: reduceDirectCommandReceipts(state.commands, fact as DirectCommandFact) };
  }
  let next = state;
  if (state.context)
    next = {
      ...next,
      context: reduceDirectContext(state.context, fact, state.queue?.records ?? state.queueRecords ?? []),
    };
  if (state.queue && isDirectQueueFact(fact)) next = { ...next, queue: reduceDirectQueue(state.queue, fact) };
  if (state.tasks && isDirectTaskFact(fact)) next = { ...next, tasks: reduceDirectBackground(state.tasks, fact) };
  return next;
}
