/** Context planning and pure replay projection. This is not a Session or a writer. */
import { z } from 'zod';
import {
  proposalSchema,
  decisionSchema,
  reportSchema,
} from '../../../source/services/completion-verification/contracts.js';
import { directRolloverFactSchema, type DirectRolloverFact } from './direct-rollover.js';
import { directSessionRotationSchema, type DirectSessionRotationFact } from './direct-session-rotation.js';
import type { Fact } from './facts.js';
import type { Item } from '../model/index.js';
import {
  renderDurableGoalContext,
  MAX_GOAL_FIELD_LENGTH,
  reduceDirectGoal,
  type DirectGoalFact,
  type DirectGoalState,
} from './direct-goal.js';
import { type DirectGoalReminderFact } from './direct-goal-stop.js';
import {
  reduceDirectVerification,
  type DirectVerificationFact,
  type DirectVerificationAttempt,
} from './direct-goal-verification.js';
import {
  planDirectPersonalMemory,
  directPersonalMemoryItem,
  reduceDirectMemory,
  type DirectMemoryCapability,
  type DirectMemoryFact,
  type DirectMemoryState,
} from './direct-memory.js';

export type DirectContextFact =
  | DirectGoalFact
  | DirectGoalReminderFact
  | DirectVerificationFact
  | DirectMemoryFact
  | DirectRolloverFact
  | DirectSessionRotationFact;
export type DirectContextState = {
  readonly goal: DirectGoalState;
  readonly memory: DirectMemoryState;
  readonly verification: readonly DirectVerificationAttempt[];
  readonly goalReminders: readonly DirectGoalReminderFact[];
};

/** Fresh projection only; the owning Session folds accepted facts over it on open. */
export function initialDirectContextState(): DirectContextState {
  return {
    goal: { generation: 0, proposalMade: false },
    memory: { automaticRecorded: false, automaticStopped: false },
    verification: [],
    goalReminders: [],
  };
}

const goalField = z.string().trim().min(1).max(MAX_GOAL_FIELD_LENGTH);
const goalSchema = z.object({
  id: z.string().min(1),
  outcome: goalField,
  successCriteria: goalField.optional(),
  status: z.enum(['active', 'achieved', 'abandoned']),
});
const identifier = z.string().min(1);
const receiptSchema = z.object({
  scope: z.literal('project'),
  id: identifier,
  quote: z.string(),
  sourceSessionId: identifier,
  undo: z.string(),
});
const contextFactSchema = z.discriminatedUnion('type', [
  directRolloverFactSchema,
  directSessionRotationSchema,
  z.object({
    type: z.literal('goal_changed'),
    goal: goalSchema.optional(),
    source: z.enum(['user', 'launcher', 'proposal', 'goal_check']),
  }),
  z.object({ type: z.literal('goal_proposed'), goal: goalSchema }),
  z.object({
    type: z.literal('goal_stop_reminded'),
    turnId: identifier,
    afterItemCount: z.number().int().nonnegative(),
    reason: z.enum(['missing_check', 'incomplete_check', 'not_achieved']),
  }),
  z.object({
    type: z.literal('completion_verification_started'),
    attemptId: identifier,
    goalGeneration: z.number().int().nonnegative(),
    proposal: proposalSchema,
  }),
  z.object({ type: z.literal('completion_verification_decided'), attemptId: identifier, decision: decisionSchema }),
  z.object({ type: z.literal('completion_verification_reported'), attemptId: identifier, report: reportSchema }),
  z.object({
    type: z.literal('completion_verification_ended'),
    attemptId: identifier,
    outcome: z.enum(['complete', 'repair', 'blocked']),
    reason: z.string(),
  }),
  z.object({ type: z.literal('memory_global_snapshot'), snapshot: z.string() }),
  z.object({ type: z.literal('memory_personal_snapshot'), admissionId: identifier, snapshot: z.string() }),
  z.object({ type: z.literal('automatic_memory_started'), admissionId: identifier }),
  z.object({
    type: z.literal('automatic_memory_finished'),
    admissionId: identifier,
    receipt: receiptSchema.optional(),
  }),
  z.object({ type: z.literal('automatic_memory_disabled'), admissionId: identifier, reason: z.string() }),
]);

/** Log decoder extension; malformed known context facts throw rather than disappear. */
export function parseDirectContextFact(raw: unknown): DirectContextFact {
  return contextFactSchema.parse(raw);
}

/** Recognize only the vocabulary, then use parseDirectContextFact for validation. */
export function isDirectContextFactType(type: string): boolean {
  return contextFactSchema.options.some((schema) => schema.shape.type.value === type);
}

/**
 * Session calls this on a candidate batch before append and installs it only
 * after append succeeds. A rejected transition cannot mutate the live view.
 * Only accepted human input resets reminders; automatic input and retries retain them.
 */
export function reduceDirectContext(
  state: DirectContextState,
  fact: Fact | DirectContextFact,
  queueRecords: readonly DirectQueueRecord[] = [],
): DirectContextState {
  switch (fact.type) {
    case 'turn_started':
    case 'queue_steered':
      return startsDirectHumanWindow(fact, queueRecords) ? { ...state, goalReminders: [] } : state;
    case 'goal_changed':
    case 'goal_proposed':
      return { ...state, goal: reduceDirectGoal(state.goal, fact) };
    case 'goal_stop_reminded':
      return { ...state, goalReminders: [...state.goalReminders, fact] };
    case 'completion_verification_started':
    case 'completion_verification_decided':
    case 'completion_verification_reported':
    case 'completion_verification_ended':
      return { ...state, verification: reduceDirectVerification(state.verification, fact) };
    case 'memory_global_snapshot':
    case 'memory_personal_snapshot':
    case 'automatic_memory_started':
    case 'automatic_memory_finished':
    case 'automatic_memory_disabled':
      return { ...state, memory: reduceDirectMemory(state.memory, fact) };
    default:
      return state;
  }
}

/**
 * Build the request-local instructions and goal snapshot in the same step.
 * Memory context is already planned/snapshotted; accept memory.facts first.
 * Refresh this at each actual model request, not only at turn admission.
 */
export function planDirectInstructions(
  base: string,
  state: DirectContextState,
  memory?: DirectMemoryCapability,
): { readonly instructions: string; readonly requestGoal: DirectGoalState } {
  const goal = { ...state.goal, ...(state.goal.goal ? { goal: { ...state.goal.goal } } : {}) };
  const suffix = memory ? [memory.guidance, memory.globalContext].filter(Boolean).join('\n\n') : '';
  return {
    instructions: base + (suffix ? `\n\n${suffix}` : '') + renderDurableGoalContext(goal.goal),
    requestGoal: goal,
  };
}

/**
 * Plan changed personal context at real human admission, never for steering,
 * goal reminders, queued system notices or replay. Commit facts atomically with
 * the unchanged raw input before provider activity, and use modelInput only in
 * the model history. Rebuild the notice from the accepted fact when reopening.
 */
export function planDirectHumanContext(deps: {
  readonly state: DirectContextState;
  readonly memory: DirectMemoryCapability;
  readonly admissionId: string;
  readonly input: readonly Item[];
}): { readonly facts: readonly DirectMemoryFact[]; readonly modelInput: readonly Item[] } {
  const personal = planDirectPersonalMemory(deps.state.memory, deps.memory, deps.admissionId);
  return {
    facts: [...deps.memory.facts, ...(personal ? [personal] : [])],
    modelInput: personal ? [directPersonalMemoryItem(personal), ...deps.input] : deps.input,
  };
}

/** Classify a goal-window boundary from accepted origin evidence, not model notice text. */
export function startsDirectHumanWindow(
  fact: Fact | DirectContextFact,
  queueRecords: readonly DirectQueueRecord[] = [],
): boolean {
  if (fact.type === 'turn_started')
    return !fact.maintenance && !fact.retryContext && !fact.silent && isDirectHumanOrigin(fact.submission?.origin);
  if (fact.type !== 'queue_steered') return false;
  return fact.messageIds.some((id) => {
    const record = queueRecords.find((record) => record.messageId === id);
    return !!record && isDirectHumanOrigin(record.request.origin);
  });
}
