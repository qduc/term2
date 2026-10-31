/** Public views of accepted context facts. Private memory snapshots are not transcript text. */
import type { DirectContextFact, DirectContextState } from '../session/direct-context.js';
import type { DirectGoalState } from '../session/direct-goal.js';
import type { DirectVerificationAttempt } from '../session/direct-goal-verification.js';
import type { WireEvent, WireGoal, WireSnapshot, WireVerification } from './direct-wire.js';

export function publicGoal(goal: NonNullable<DirectGoalState['goal']>): WireGoal {
  return { id: goal.id, text: goal.outcome, status: goal.status,
    ...(goal.successCriteria !== undefined ? { successCriteria: goal.successCriteria } : {}) };
}
export function publicVerification(attempt: DirectVerificationAttempt): WireVerification {
  return { attemptId: attempt.attemptId, goalGeneration: attempt.goalGeneration, revision: attempt.proposal.revision,
    status: attempt.outcome === 'complete' ? 'passed' : attempt.outcome === 'blocked' ? 'blocked' : attempt.outcome === 'repair' ? 'failed' : 'running',
    ...(attempt.reason !== undefined ? { message: attempt.reason } : {}),
    ...(attempt.report ? { report: { outcome: attempt.report.outcome, evidence: attempt.report.evidence,
      checked: [...attempt.report.checked], limitations: [...attempt.report.limitations], verifierVersion: attempt.report.verifierVersion } } : {}),
  };
}
export function publicContext(context: DirectContextState): Pick<WireSnapshot, 'goal' | 'goalGeneration' | 'verification'> {
  const last = context.verification.at(-1);
  return { goal: context.goal.goal ? publicGoal(context.goal.goal) : null, goalGeneration: context.goal.generation,
    verification: last ? publicVerification(last) : null };
}
/** Exactly one public frame for each native context fact; no goal completion before acceptance. */
export function contextFactEvent(fact: DirectContextFact, state: WireSnapshot, seq: number): WireEvent {
  const base = { sessionId: state.sessionId, seq, turnId: 'turnId' in fact ? fact.turnId : null };
  switch (fact.type) {
    case 'goal_changed': return { ...base, type: 'goal', payload: { goal: fact.goal ? publicGoal(fact.goal) : null, generation: (state.goalGeneration ?? 0) + 1 } };
    case 'goal_proposed': return { ...base, type: 'goal_proposed', payload: { goal: publicGoal(fact.goal) } };
    case 'completion_verification_started': return { ...base, type: 'verification', payload: { verification: {
      attemptId: fact.attemptId, goalGeneration: fact.goalGeneration, revision: fact.proposal.revision, status: 'running',
    } } };
    case 'completion_verification_decided': return { ...base, type: 'verification', payload: { verification: {
      ...state.verification, attemptId: fact.attemptId, status: 'running', message: fact.decision.reason,
    } } };
    case 'completion_verification_reported': return { ...base, type: 'verification', payload: { verification: {
      ...state.verification, attemptId: fact.attemptId, status: 'running', report: {
        outcome: fact.report.outcome, evidence: fact.report.evidence, checked: [...fact.report.checked],
        limitations: [...fact.report.limitations], verifierVersion: fact.report.verifierVersion,
      },
    } } };
    case 'completion_verification_ended': return { ...base, type: 'verification', payload: { verification: {
      ...state.verification, attemptId: fact.attemptId, status: fact.outcome === 'complete' ? 'passed' : fact.outcome === 'blocked' ? 'blocked' : 'failed', message: fact.reason,
    } } };
    case 'goal_stop_reminded': return { ...base, type: 'notice', payload: { kind: fact.type, message: `Goal stop reminder: ${fact.reason} (${fact.afterItemCount} accepted items).` } };
    case 'memory_global_snapshot':
    case 'memory_personal_snapshot': return { ...base, type: 'notice', payload: { kind: fact.type, message: 'Memory context snapshot accepted.' } };
    case 'automatic_memory_started': return { ...base, type: 'notice', payload: { kind: fact.type, message: 'Automatic memory recording started.' } };
    case 'automatic_memory_finished': return { ...base, type: 'notice', payload: { kind: fact.type, message: fact.receipt ? `Automatic memory recorded (${fact.receipt.id}).` : 'Automatic memory recording finished without a receipt.' } };
    case 'automatic_memory_disabled': return { ...base, type: 'notice', payload: { kind: fact.type, message: fact.reason } };
  }
}
