import type { RunBudgetEvidence } from '../services/agent-runtime/run-budget.js';

const MAX_TURNS_LEFT_THRESHOLD = 5;

export function buildTurnLimitWarning(turnsLeft: number): string {
  return `

[Warning: You are approaching the maximum turn limit. You have ${turnsLeft} turns left. Please prepare to wrap up your work and provide a situation update message describing what has been completed and what remains to be done.]`;
}

export interface TurnLimitContext {
  turnCount?: number;
  maxTurns?: number;
}

/** The run-loop budget context a tool wrapper can use without knowing budget state. */
export interface RunBudgetWarningContext {
  readonly budget?: {
    takeSoftEvidence?: () => RunBudgetEvidence | undefined;
  };
}

export function buildRunBudgetWarning(evidence: RunBudgetEvidence): string {
  const labels: Record<RunBudgetEvidence['dimension'], string> = {
    usd: 'priced USD budget',
    unpriced_tokens: 'unpriced-token budget',
    active_time: 'active-time budget',
    turns: 'turn backstop',
  };
  return `\n\n[Warning: The ${labels[evidence.dimension]} is approaching exhaustion (${
    evidence.headroom
  } remaining). Please prepare to wrap up your work and provide a situation update describing what has been completed and what remains.]`;
}

/**
 * Reads the turn budget out of whatever context a tool was invoked with.
 *
 * Under `ApplicationRunLoop` the loop owns the count and exposes it as
 * `toolContext.turn`; under the legacy orchestrator path the count is kept on
 * the run's user context by a model-input filter. Tools serve both paths, so
 * this resolves either shape and prefers the loop's, which is authoritative
 * when present.
 */
export function resolveTurnLimitContext(toolContext: unknown): TurnLimitContext | undefined {
  const candidate = toolContext as { turn?: { count?: number; max?: number }; context?: TurnLimitContext } | undefined;
  const turn = candidate?.turn;
  if (turn && typeof turn.count === 'number' && typeof turn.max === 'number') {
    return { turnCount: turn.count, maxTurns: turn.max };
  }
  return candidate?.context;
}

export function injectTurnLimitWarning(output: string, context: unknown): string {
  const limitContext = context as TurnLimitContext | undefined;
  if (limitContext && typeof limitContext.turnCount === 'number' && typeof limitContext.maxTurns === 'number') {
    const turnsLeft = limitContext.maxTurns - limitContext.turnCount;
    if (turnsLeft >= 0 && turnsLeft <= MAX_TURNS_LEFT_THRESHOLD) {
      return injectWarningIntoToolOutput(output, buildTurnLimitWarning(turnsLeft));
    }
  }
  return output;
}

/**
 * Inject the nearest soft-stage budget evidence into exactly one tool result.
 * The legacy turn warning remains as a compatibility fallback for callers that
 * have not moved onto an application-owned run budget yet.
 */
export function injectRunBudgetWarning(output: string, context: unknown): string {
  const budget = (context as RunBudgetWarningContext | undefined)?.budget;
  if (budget) {
    const evidence = budget.takeSoftEvidence?.();
    return evidence ? injectWarningIntoToolOutput(output, buildRunBudgetWarning(evidence)) : output;
  }
  return injectTurnLimitWarning(output, resolveTurnLimitContext(context));
}

export const injectWarningIntoToolOutput = (output: string, warning: string): string => {
  if (!output) {
    return warning;
  }

  const appendToField = (record: Record<string, any>): boolean => {
    for (const field of ['stdout', 'content', 'error', 'text', 'message']) {
      if (typeof record[field] === 'string') {
        record[field] += warning;
        return true;
      }
    }

    return false;
  };

  const appendToValue = (val: unknown): unknown => {
    if (typeof val === 'string') return val + warning;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const record = val as Record<string, any>;
      if (!appendToField(record)) {
        record.warning = warning.trim();
      }
      return record;
    }
    return val;
  };

  try {
    const parsed = JSON.parse(output);

    if (typeof parsed === 'string') {
      return JSON.stringify(parsed + warning);
    }

    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, any>;

      if (Array.isArray(obj.output)) {
        if (obj.output.length > 0) {
          const lastIdx = obj.output.length - 1;
          const lastItem = obj.output[lastIdx];
          if (typeof lastItem === 'string' || (lastItem && typeof lastItem === 'object' && !Array.isArray(lastItem))) {
            obj.output[lastIdx] = appendToValue(lastItem);
          } else {
            obj.output.push({ success: true, stdout: warning });
          }
        } else {
          obj.output.push({ success: true, stdout: warning });
        }
        return JSON.stringify(obj);
      }

      if (Array.isArray(parsed)) {
        if (parsed.length > 0) {
          const lastIdx = parsed.length - 1;
          const lastItem = parsed[lastIdx];
          if (typeof lastItem === 'string' || (lastItem && typeof lastItem === 'object' && !Array.isArray(lastItem))) {
            parsed[lastIdx] = appendToValue(lastItem);
          } else {
            parsed.push(warning);
          }
        } else {
          parsed.push(warning);
        }
        return JSON.stringify(parsed);
      }

      if (!appendToField(obj)) {
        obj.warning = warning.trim();
      }
      return JSON.stringify(obj);
    }

    return JSON.stringify(parsed) + warning;
  } catch {
    return output + warning;
  }
};
