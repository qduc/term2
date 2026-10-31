/** Completion verification uses Session facts, never the old verification database. */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BUDGETS,
  POLICY_VERSION,
  decisionSchema,
  proposalSchema,
  reportSchema,
  type CompletionProposal,
  type GateDecision,
  type VerificationReport,
  type VerificationRequest,
} from '../../../source/services/completion-verification/contracts.js';
import { mandatoryVerification } from '../../../source/services/completion-verification/gate.js';
import type { DirectGoalCheck, DirectGoalState } from './direct-goal.js';
import type { DirectGoalVerificationVerdict } from './direct-goal-stop.js';

export type DirectVerificationFact =
  | {
      readonly type: 'completion_verification_started';
      readonly attemptId: string;
      readonly goalGeneration: number;
      readonly proposal: CompletionProposal;
    }
  | { readonly type: 'completion_verification_decided'; readonly attemptId: string; readonly decision: GateDecision }
  | {
      readonly type: 'completion_verification_reported';
      readonly attemptId: string;
      readonly report: VerificationReport;
    }
  | {
      readonly type: 'completion_verification_ended';
      readonly attemptId: string;
      readonly outcome: 'complete' | 'repair' | 'blocked';
      readonly reason: string;
    };
export type DirectVerificationAttempt = {
  readonly attemptId: string;
  readonly goalGeneration: number;
  readonly proposal: CompletionProposal;
  readonly decision?: GateDecision;
  readonly report?: VerificationReport;
  readonly outcome?: 'complete' | 'repair' | 'blocked';
  readonly reason?: string;
};
export type DirectVerificationOperations = {
  /** Safe host-owned workspace snapshot. Do not take paths/classification from the model. */
  snapshot(
    signal: AbortSignal,
  ): Promise<Pick<CompletionProposal, 'revision' | 'environment' | 'classification' | 'files' | 'quickCheck'>>;
  currentRevision(signal: AbortSignal): Promise<string>;
  /** Optional adaptive recommendation; mandatory executable/sensitive policy still wins. */
  gate?(proposal: CompletionProposal, signal: AbortSignal): Promise<unknown>;
  /** Must run a distinct read-only direct agent, with real probes; never the working model's self-report. */
  verify(request: VerificationRequest, signal: AbortSignal): Promise<unknown>;
  quickCheck?(proposal: CompletionProposal, request: VerificationRequest, signal: AbortSignal): Promise<unknown>;
};

/** Replay projection with transition validation. An unfinished attempt is not a PASS. */
export function reduceDirectVerification(
  attempts: readonly DirectVerificationAttempt[],
  fact: DirectVerificationFact,
): readonly DirectVerificationAttempt[] {
  const index = attempts.findIndex((attempt) => attempt.attemptId === fact.attemptId);
  if (fact.type === 'completion_verification_started') {
    if (index >= 0) throw new Error('Duplicate completion verification attempt');
    return [
      ...attempts,
      { attemptId: fact.attemptId, goalGeneration: fact.goalGeneration, proposal: proposalSchema.parse(fact.proposal) },
    ];
  }
  if (index < 0) throw new Error('Unknown completion verification attempt');
  const current = attempts[index]!;
  if (current.outcome) throw new Error('Completion verification attempt already ended');
  let next: DirectVerificationAttempt;
  switch (fact.type) {
    case 'completion_verification_decided': {
      if (current.decision) throw new Error('Completion verification already decided');
      const decision = decisionSchema.parse(fact.decision);
      if (mandatoryVerification(current.proposal) && decision.action !== 'independent_verify')
        throw new Error('Mandatory independent verification cannot be skipped');
      if (decision.action === 'quick_check' && !current.proposal.quickCheck)
        throw new Error('Quick check requires a host-owned checker');
      next = { ...current, decision };
      break;
    }
    case 'completion_verification_reported': {
      if (!current.decision || current.report) throw new Error('Unexpected completion verification report');
      const report = reportSchema.parse(fact.report);
      if (report.attemptId !== current.attemptId || report.revision !== current.proposal.revision)
        throw new Error('Stale completion verification report');
      next = { ...current, report };
      break;
    }
    case 'completion_verification_ended':
      if (fact.outcome === 'complete' && !(current.decision?.action === 'skip' || current.report?.outcome === 'PASS')) {
        throw new Error('Completion without accepted verification evidence');
      }
      if (fact.outcome === 'repair' && current.report?.outcome !== 'FAIL')
        throw new Error('Repair without a failure report');
      next = { ...current, outcome: fact.outcome, reason: fact.reason };
      break;
  }
  return attempts.map((attempt, position) => (position === index ? next : attempt));
}

/**
 * One verification operation, not a run loop or another durable store. Session
 * serializes stop evaluation and atomically accepts facts against goal generation.
 * Unavailable, invalid, stale, cancelled and inconclusive verification never closes
 * a goal. Transport/deadline policy belongs to the injected operations.
 */
export function createDirectGoalVerifier(deps: {
  readonly sessionId: string;
  readonly readAttempts: () => readonly DirectVerificationAttempt[];
  readonly commit: (
    expectedGoalGeneration: number,
    facts: readonly DirectVerificationFact[],
  ) => boolean | Promise<boolean>;
  readonly operations: DirectVerificationOperations;
  readonly limits?: {
    readonly maxRepairs: number;
    readonly maxGateAttempts: number;
    readonly maxVerifications: number;
  };
}): (state: DirectGoalState, check: DirectGoalCheck, signal: AbortSignal) => Promise<DirectGoalVerificationVerdict> {
  const limits = deps.limits ?? DEFAULT_BUDGETS;
  for (const [key, minimum] of [
    ['maxRepairs', 0],
    ['maxGateAttempts', 1],
    ['maxVerifications', 1],
  ] as const) {
    if (!Number.isInteger(limits[key]) || limits[key] < minimum)
      throw new Error(`Invalid completion verification ${key}`);
  }
  return async (state, check, signal) => {
    const blocked = (reason: string, unavailable = false): DirectGoalVerificationVerdict => ({
      action: 'blocked',
      reason,
      unavailable,
    });
    if (!state.goal || state.goal.status !== 'active' || check.status !== 'achieved')
      return blocked('No active achieved claim');
    const attempts = deps
      .readAttempts()
      .filter((attempt) => attempt.proposal.taskId === `${deps.sessionId}:${state.goal!.id}`);
    if (attempts.some((attempt) => !attempt.outcome))
      return blocked('An earlier verification is unfinished; explicit recovery is required');
    if (attempts.length >= limits.maxGateAttempts) return blocked('Completion gate attempt budget exhausted');
    const attemptId = randomUUID();
    let started = false;
    let report: VerificationReport | undefined;
    const accept = async (facts: readonly DirectVerificationFact[]): Promise<void> => {
      if (signal.aborted) throw new Error('Task cancelled');
      if (!(await deps.commit(state.generation, facts)))
        throw new Error('Goal changed or verification persistence failed');
    };
    const end = async (outcome: 'complete' | 'repair' | 'blocked', reason: string): Promise<void> => {
      await accept([{ type: 'completion_verification_ended', attemptId, outcome, reason }]);
    };
    try {
      const snapshot = await deps.operations.snapshot(signal);
      const proposal = proposalSchema.parse({
        ...snapshot,
        taskId: `${deps.sessionId}:${state.goal.id}`,
        goal: state.goal.outcome,
        criteria: state.goal.successCriteria ?? '',
        evidence: check.evidence + (check.criteriaEvidence ? `\n${check.criteriaEvidence}` : ''),
      });
      await accept([
        { type: 'completion_verification_started', attemptId, goalGeneration: state.generation, proposal },
      ]);
      started = true;
      let decision: GateDecision = {
        action: 'independent_verify',
        policyVersion: POLICY_VERSION,
        reason: 'Conservative default: independent verification',
      };
      if (!mandatoryVerification(proposal) && deps.operations.gate) {
        try {
          decision = decisionSchema.parse(await deps.operations.gate(proposal, signal));
        } catch {
          /* Invalid or unavailable recommendation keeps the conservative default. */
        }
      }
      if (decision.action === 'quick_check' && (!proposal.quickCheck || !deps.operations.quickCheck)) {
        decision = {
          action: 'independent_verify',
          policyVersion: POLICY_VERSION,
          reason: 'No applicable host-owned quick check',
        };
      }
      await accept([{ type: 'completion_verification_decided', attemptId, decision }]);
      if (decision.action !== 'skip') {
        const used = attempts.filter((attempt) => attempt.decision && attempt.decision.action !== 'skip').length;
        if (used >= limits.maxVerifications) {
          await end('blocked', 'Verification budget exhausted');
          return blocked('Verification budget exhausted');
        }
        const request: VerificationRequest = {
          attemptId,
          goal: proposal.goal,
          criteria: proposal.criteria,
          revision: proposal.revision,
          environment: proposal.environment,
        };
        report = reportSchema.parse(
          await (decision.action === 'quick_check'
            ? deps.operations.quickCheck!(proposal, request, signal)
            : deps.operations.verify(request, signal)),
        );
        if (report.attemptId !== attemptId || report.revision !== proposal.revision)
          throw new Error('Stale verification report');
        await accept([{ type: 'completion_verification_reported', attemptId, report }]);
      }
      if ((await deps.operations.currentRevision(signal)) !== proposal.revision)
        throw new Error('Workspace changed during verification');
      if (report && report.outcome !== 'PASS') {
        const repairs = attempts.filter((attempt) => attempt.outcome === 'repair').length;
        if (report.outcome === 'FAIL' && repairs < limits.maxRepairs) {
          await end('repair', report.evidence);
          return { action: 'repair', evidence: report.evidence };
        }
        const reason =
          report.outcome === 'FAIL'
            ? 'Repair budget exhausted'
            : `Independent verification ${report.outcome.toLowerCase()}`;
        await end('blocked', reason);
        return blocked(reason, report.outcome !== 'FAIL');
      }
      await end('complete', report?.evidence ?? decision.reason);
      return { action: 'complete' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (started && !signal.aborted) {
        try {
          await end('blocked', reason);
        } catch {
          /* A poisoned/stale Session cannot be repaired by this capability. */
        }
      }
      return blocked(reason, report?.outcome !== 'FAIL' && report?.outcome !== 'PASS');
    }
  };
}
