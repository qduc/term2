/** Term2 compatibility surface; implementation lives in the portable harness package. */
export { clampRunBudgetPolicy } from '@qduc/agent-harness-core';
export type {
  RunBudgetPolicy,
  RunBudgetEvent,
  RunBudgetEvidence,
  RunBudgetSnapshot,
  ToolStallObservation,
  ModelRequestCost,
} from '@qduc/agent-harness-core';
export { RunBudget, readRunBudgetPolicy } from './agent-runtime/run-budget.js';
