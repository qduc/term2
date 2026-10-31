/**
 * Rollover moves a session's work to a new log. The Session calls this while it
 * holds its command reservation, so nothing can be admitted between the checks
 * here and the new session being written. Anything that cannot move refuses
 * before that write: queued input and live tasks belong to the old writer, and an
 * open approval would lose the only client that can answer it.
 */
import { randomUUID } from 'node:crypto';
import type { SessionRolloverRequest } from '../../../source/contracts/session-rollover.js';
import { composeSessionRolloverBrief } from '../../../source/services/session-rollover/session-rollover-brief.js';
import type { DirectCommandOutcome } from '../session/direct-command-types.js';
import type { DurableGoal } from '../session/direct-goal.js';
import type { DirectSession, DirectSessionState } from '../session/facade-types.js';

type Refusal = Extract<DirectCommandOutcome, { readonly kind: 'rejected' }>;

const refuse = (code: Refusal['code'], message: string): Refusal => ({ kind: 'rejected', code, message });

function veto(state: DirectSessionState): Refusal | undefined {
  if (state.pendingInteractions.length) return refuse('busy', 'Answer the pending approval or question first.');
  if (state.pendingBudgets.length) return refuse('busy', 'Answer the pending run budget check-in first.');
  if (state.activeTurnId !== null) return refuse('busy', 'Stop the running turn first.');
  if (state.queue.pending.length) return refuse('ineligible', 'Queued input cannot move to a new session yet.');
  const live = state.tasks.filter((task) => ['running', 'waiting_for_answer', 'cancelling'].includes(task.status));
  if (live.length) {
    const names = live.map((task) => task.taskId).join(', ');
    return refuse('ineligible', `Background work cannot move to a new session yet: ${names}.`);
  }
  return undefined;
}

export type DirectRolloverInput = {
  readonly sessionId: string;
  readonly state: DirectSessionState;
  /** The model's handoff. A client's `/rollover` has none, so its successor starts no turn. */
  readonly request?: SessionRolloverRequest;
  /** Writes the successor, keeping the source's workspace, model, owner and settings. */
  create(): Promise<DirectSession>;
  carryGoal(successor: DirectSession, goal: DurableGoal): void;
};

export async function rollSessionOver(input: DirectRolloverInput): Promise<DirectCommandOutcome> {
  const { sessionId, state, request } = input;
  const refusal = veto(state);
  if (refusal) return refusal;
  const successor = await input.create();
  const { goal } = state.context.goal;
  if (goal) input.carryGoal(successor, goal);
  if (!request) return { kind: 'rolled_over', sessionId: successor.id };
  const admission = await successor.submitWithDelivery({
    clientRequestId: randomUUID(),
    content: [{ type: 'text', text: composeSessionRolloverBrief({ previousSessionId: sessionId, request }) }],
    delivery: 'auto',
    // Not a person, so it gets no human memory context or authority.
    origin: { kind: 'control', id: 'session-rollover' },
  });
  if (admission.kind === 'rejected') {
    // Printed so the brief survives: nothing retries it, as today.
    return refuse(
      'failed',
      `Session ${successor.id} did not take the handoff: ${admission.reason}\n\n${request.brief}`,
    );
  }
  return { kind: 'rolled_over', sessionId: successor.id };
}
