import { type AgentStream } from '../agent-stream.js';
import { type RunBudgetEvent } from './run-budget.js';
import type { ApplicationRunLoopDeps } from './run-loop-contracts.js';
import { EventQueue, outputPush } from './run-segment-events.js';
import type { RunState } from './run-state.js';

/** Pure disposition of existing evidence; sensors, thresholds and grants remain in RunBudget. */
export function budgetDisposition(
  escalation: RunState['runBudgetEscalation'],
  wrapUp: boolean | undefined,
  pending: boolean,
  event: RunBudgetEvent,
): 'disabled' | 'wrap_up' | 'check_in' | 'observe' {
  if (escalation === 'disabled') return 'disabled';
  if (event.type === 'budget_stage' && event.stage === 'critical' && wrapUp) return 'wrap_up';
  if (
    !wrapUp &&
    !pending &&
    (escalation === 'contain'
      ? event.type === 'budget_stage' && event.stage === 'critical'
      : escalation !== 'warn' &&
        (event.type === 'tool_stall' || (event.type === 'budget_stage' && event.stage !== 'soft')))
  )
    return 'check_in';
  return 'observe';
}
export function evaluateRunBudget(
  state: RunState,
  stream?: AgentStream,
  queue?: EventQueue,
  logDiagnostic?: ApplicationRunLoopDeps['logDiagnostic'],
): void {
  if (!state.runBudget) return;
  for (const event of state.runBudget.evaluate({
    turns: state.turnCount,
    costRecords: state.costRecords ?? [],
  })) {
    emitRunBudgetEvent(state, event, 'Run budget evidence', stream, queue, logDiagnostic);
  }
}
export function emitRunBudgetEvent(
  state: RunState,
  event: RunBudgetEvent,
  message: string,
  stream?: AgentStream,
  queue?: EventQueue,
  logDiagnostic?: ApplicationRunLoopDeps['logDiagnostic'],
): void {
  const disposition = budgetDisposition(
    state.runBudgetEscalation,
    state.wrapUpOnCriticalRunBudget,
    Boolean(state.pendingRunBudgetInteraction),
    event,
  );
  if (disposition === 'disabled') return;
  if (disposition === 'wrap_up') {
    state.criticalWrapUpPending = true;
    state.terminalCause = 'budget_exhausted';
  }
  if (disposition === 'check_in') {
    state.pendingRunBudgetInteraction = { type: 'run_budget_interaction', event };
    state.runBudgetGrantConsumed = false;
  }
  if (stream && queue) outputPush(stream, queue, { type: 'run_budget', evidence: event });
  try {
    state.onRunBudgetEvent?.(event);
  } catch {
    // Evidence observers are delivery adapters, not budget owners.
    logDiagnostic?.('Run budget event observer failed', { type: event.type });
  }
  logDiagnostic?.(message, event);
}
/**
 * Charge this interaction's extension unless a caller already took it.
 *
 * An ungranted arrival here means nobody was prompted — the continuation
 * applier, non-interactive mode, `--auto-approve`. That is a parent-class
 * grant, so it is capped and eventually refuses.
 */
export function takeRunBudgetGrant(state: RunState): boolean {
  if (state.runBudgetGrantConsumed) {
    state.runBudgetGrantConsumed = false;
    return true;
  }
  if (!state.runBudget) return true;
  return state.runBudget.grantExtension('parent').granted;
}
