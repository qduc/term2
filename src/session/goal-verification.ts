/** Completion verification uses Session facts, never the old verification database. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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
} from './completion-verification/contracts.js';
import { mandatoryVerification } from './completion-verification/gate.js';
import type { DirectGoalCheck, DirectGoalState } from './goal.js';
import type { DirectGoalVerificationVerdict } from './goal-stop.js';

/** Native count limits only; transport/deadline policy remains operation-owned. */
export const directVerificationLimitsSchema = z.object({
  maxRepairs: z.number().int().nonnegative(),
  maxGateAttempts: z.number().int().positive(),
  maxVerifications: z.number().int().positive(),
});
export type DirectVerificationLimits = z.infer<typeof directVerificationLimitsSchema>;
const defaultLimits = (): DirectVerificationLimits => directVerificationLimitsSchema.parse(DEFAULT_BUDGETS);

export type DirectVerificationFact =
  | {
      readonly type: 'completion_verification_started';
      readonly attemptId: string;
      readonly goalGeneration: number;
      readonly proposal: CompletionProposal;
      /** First task attempt pins counts; absence on legacy facts means historical defaults. */
      readonly limits?: DirectVerificationLimits;
      /** First task attempt pins the task deadline (epoch ms); later attempts carry it. Absent on older facts: no deadline. */
      readonly deadline?: number;
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
  readonly limits?: DirectVerificationLimits;
  readonly deadline?: number;
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
    const proposal = proposalSchema.parse(fact.proposal);
    const limits = fact.limits ? directVerificationLimitsSchema.parse(fact.limits) : defaultLimits();
    const previous = attempts.find((attempt) => attempt.proposal.taskId === proposal.taskId);
    if (previous) {
      const pinned = previous.limits ?? defaultLimits();
      if ((['maxRepairs', 'maxGateAttempts', 'maxVerifications'] as const).some((key) => limits[key] !== pinned[key]))
        throw new Error('Completion verification task budget changed');
    }
    return [
      ...attempts,
      {
        attemptId: fact.attemptId,
        goalGeneration: fact.goalGeneration,
        proposal,
        limits,
        ...(fact.deadline !== undefined ? { deadline: fact.deadline } : {}),
      },
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
  readonly limits?: DirectVerificationLimits;
}): (state: DirectGoalState, check: DirectGoalCheck, signal: AbortSignal) => Promise<DirectGoalVerificationVerdict> {
  const newTaskLimits = directVerificationLimitsSchema.parse(deps.limits ?? DEFAULT_BUDGETS);
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
    // Generation/revision/configuration changes are not new tasks. Old facts
    // without a pin used defaults, even if today's setting has changed.
    const limits = attempts.length ? attempts[0]!.limits ?? defaultLimits() : newTaskLimits;
    // Legacy settles every block as the task's final state; only a new goal starts over.
    if (attempts.some((attempt) => attempt.outcome === 'blocked'))
      return blocked('Task contract changed or task is terminal; explicit administrative recovery required');
    if (attempts.some((attempt) => !attempt.outcome))
      return blocked('An earlier verification is unfinished; explicit recovery is required');
    // Legacy: one deadline per task, set by its first claim; a later claim past it, or past the gate budget, is blocked.
    const deadline = attempts[0]?.deadline ?? Date.now() + DEFAULT_BUDGETS.taskTimeoutMs;
    if (attempts.length && (deadline <= Date.now() || attempts.length >= limits.maxGateAttempts))
      return blocked('Task deadline or gate budget exhausted');
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
        {
          type: 'completion_verification_started',
          attemptId,
          goalGeneration: state.generation,
          proposal,
          limits,
          deadline,
        },
      ]);
      started = true;
      // A repair that left the repository as it was is not progress; legacy blocks the task here, before any gate.
      if (attempts.length && attempts.at(-1)!.proposal.revision === proposal.revision)
        throw new Error('Repair made no repository progress');
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
      if (Date.now() >= deadline) throw new Error('Task deadline exhausted');
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
        // One bounded operation, as legacy's operationTimeoutMs; any failure of it reads the same to the user.
        const operationSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, Math.min(deadline - Date.now(), DEFAULT_BUDGETS.operationTimeoutMs))),
        ]);
        try {
          report = reportSchema.parse(
            await (decision.action === 'quick_check'
              ? deps.operations.quickCheck!(proposal, request, operationSignal)
              : deps.operations.verify(request, operationSignal)),
          );
        } catch {
          throw new Error('Verifier timeout, error, cancellation, or malformed result');
        }
        if (report.outcome === 'ERROR' || operationSignal.aborted)
          throw new Error('Verifier timeout, error, cancellation, or malformed result');
        if (report.attemptId !== attemptId || report.revision !== proposal.revision)
          throw new Error('Stale, late, conflicting, or cancelled verification result');
        await accept([{ type: 'completion_verification_reported', attemptId, report }]);
      }
      if ((await deps.operations.currentRevision(signal)) !== proposal.revision)
        throw new Error('Stale, late, conflicting, or cancelled verification result');
      if (report && report.outcome !== 'PASS') {
        const repairs = attempts.filter((attempt) => attempt.outcome === 'repair').length;
        // Legacy also stops a repair that fails with the very same evidence as the previous report.
        const previousEvidence = attempts.filter((attempt) => attempt.report).at(-1)?.report?.evidence;
        const verificationsAfter = attempts.filter((a) => a.decision && a.decision.action !== 'skip').length + 1;
        if (
          report.outcome === 'FAIL' &&
          repairs < limits.maxRepairs &&
          verificationsAfter < limits.maxVerifications &&
          Date.now() < deadline &&
          previousEvidence !== report.evidence
        ) {
          await end('repair', report.evidence);
          return { action: 'repair', evidence: report.evidence };
        }
        const reason =
          report.outcome === 'FAIL'
            ? 'Repair budget, deadline, or repeated-failure limit reached'
            : `Verification ${report.outcome}; completion not established`;
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
