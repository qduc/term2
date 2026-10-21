import type { ProviderInputItem } from '../../contracts/provider-input.js';
import type { DurableGoal } from '../logging/conversation-log-events.js';
import type { ApplicationAgent, NormalStopDecision } from '../agent-runtime/application-run-loop.js';
import { createGoalStopPolicy, decideGoalStop } from '../conversation/durable-goal-stop-check.js';
import type { CompletionVerdict } from './contracts.js';

export function createVerifiedGoalStopPolicy(deps: {
  getGoal(): DurableGoal | undefined;
  unattended?: boolean;
  onGoalAchieved?: (goal: DurableGoal) => void;
  verify(goal: DurableGoal, history: readonly ProviderInputItem[], signal?: AbortSignal): Promise<CompletionVerdict>;
}) {
  const ordinary = createGoalStopPolicy(deps.getGoal, deps.onGoalAchieved);
  return async (
    history: readonly ProviderInputItem[],
    agent: Pick<ApplicationAgent, 'tools'>,
    signal?: AbortSignal,
  ): Promise<NormalStopDecision> => {
    const goal = deps.getGoal();
    if (
      !agent.tools.some((tool) => tool.name === 'goal_check') ||
      decideGoalStop(goal, history).reason !== 'achieved' ||
      !goal
    ) {
      return ordinary(history, agent);
    }
    const blocked = (reason: string, unavailable = false): NormalStopDecision =>
      unavailable && deps.unattended && !signal?.aborted
        ? {
            action: 'stop',
            notice: `independent verification not performed: ${reason}. The durable goal remains active.`,
            diagnostics: { guard: 'completion_verification', outcome: 'unavailable', reason },
          }
        : {
            action: 'stop',
            terminalCause: 'completion_verification_blocked',
            notice: `Completion verification blocked: ${reason}. The durable goal remains active.`,
            diagnostics: { guard: 'completion_verification', outcome: 'blocked', reason },
          };
    try {
      const verdict = await deps.verify({ ...goal }, history, signal).catch(() => ({
        action: 'blocked' as const,
        reason: 'Independent verifier unavailable',
        record: undefined,
      }));
      const current = deps.getGoal();
      if (signal?.aborted || JSON.stringify(current) !== JSON.stringify(goal)) {
        return blocked('Goal changed or task cancelled during verification');
      }
      if (verdict.action === 'blocked')
        return blocked(
          verdict.reason,
          verdict.record?.report?.outcome !== 'FAIL' && verdict.record?.report?.outcome !== 'PASS',
        );
      if (verdict.action === 'repair')
        return {
          action: 'continue',
          repairDeadline: verdict.record.deadline,
          reminder:
            'Independent verification found a reproducible failure. Repair the problem, verify the outcome, and call goal_check again. ' +
            'Existing user permissions still apply. Prior observation (reproduce against the current state): ' +
            verdict.record.report?.evidence.slice(0, 8000),
          diagnostics: { guard: 'completion_verification', outcome: 'repair', attemptId: verdict.record.attemptId },
        };
      if (!deps.onGoalAchieved) return blocked('No authoritative goal persistence callback');
      deps.onGoalAchieved({ ...goal, status: 'achieved' });
      return {
        action: 'stop',
        diagnostics: {
          guard: 'completion_verification',
          outcome: 'complete',
          method: verdict.record.decision?.action,
          attemptId: verdict.record.attemptId,
          policyVersion: verdict.record.decision?.policyVersion,
        },
      };
    } catch {
      return blocked('Verification or goal persistence failed');
    }
  };
}
