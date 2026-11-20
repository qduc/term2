/** Term2 compatibility surface (types only); implementation lives in the portable harness package.
 * Runtime code takes `ModelFailure` from `./failure.js`. */
export type {
  ModelRecoveryEvidence,
  ModelRecoveryBudget,
  ItemId,
  ToolCallId,
  ContentPart,
  ProviderOpaqueItem,
  ProviderInputItem,
  Item,
  ModelRef,
  ToolSpec,
  ReasoningEffort,
  ModelRequest,
  ModelAffinity,
  Usage,
  StopReason,
  ToolCallArgumentProgress,
  ProviderStatus,
  ModelEvent,
  ModelErrorKind,
  ModelError,
  ModelCapabilities,
  Model,
  ModelRegistry,
} from '@qduc/agent-core';

/** A Codex rate-limit window as Term2 shows it: percent used and the epoch second it resets. */
export type CodexWeeklyQuota = { readonly usedPercent: number; readonly resetAt: number };
