import type { NormalizedUsage } from '../../utils/ai/token-usage.js';

// ─── Model Policy ────────────────────────────────────────────────

/** Named convenience tier. */
export type ModelTier = 'efficient' | 'balanced' | 'capable';

/** Relative tier adjustment against a parent agent. */
export interface RelativeModelPolicy {
  tier: 'lower' | 'same' | 'higher';
  /** Request a reasoning-capable model with the given effort level when adjusting. */
  reasoning?: 'low' | 'medium' | 'high';
}

/** Exact model override. */
export interface ExactModelPolicy {
  provider: string;
  model: string;
}

/** Model selection policy for an agent. */
export type ModelPolicy = ModelTier | RelativeModelPolicy | ExactModelPolicy;

// ─── Permissions (public API) ─────────────────────────────────────

/**
 * Public agent permission shape.
 *
 * Fine-grained filesystem globs and network host scopes are resolved
 * and enforced at tool-invocation time. Omitted scopes inherit from
 * parent or default to no authority for public custom agents; legacy
 * trusted role presets retain their coarse behavior through explicit
 * host scopes (undefined = no fine-grained restriction).
 */
export interface AgentPermissions {
  /** Requested tool names (subset of available tools). */
  tools?: ReadonlyArray<string>;
  /** Filesystem access scopes. Empty array = explicitly no authority. Omitted = no restriction beyond coarse flags. */
  filesystem?: {
    read?: string[];
    write?: string[];
  };
  /** Network access scopes. Empty array = explicitly no authority. Omitted = no restriction beyond coarse flags. */
  network?: {
    hosts?: string[];
  };
  /** Nested agent creation policy. */
  agents?: {
    create?: boolean;
    maxDepth?: number;
    allowedModels?: ModelPolicy[];
  };
}

// ─── Internal coarse resolution ───────────────────────────────────

/**
 * Internal coarse permission shape used by legacy subagent adapters
 * and tool-policy resolution. Not part of the public API.
 */
export interface ResolvedAgentPermissions {
  canRead: boolean;
  canWrite: boolean;
  canRunShell: boolean;
  canSearchWeb: boolean;
  canUseNestedAgents: boolean;
}

// ─── Limits ───────────────────────────────────────────────────────

/**
 * Resource limits for an agent run.
 *
 * Child limits are always clamped to parent maxima.
 * - `timeoutMs` is enforced via AbortSignal cancellation.
 * - `maxTurns`, `maxChildren`, `maxDepth`, `maxConcurrency` are
 *   enforced by the execution-tree budget (ExecutionBudget).
 * - `maxTokens` is passed to the model provider as a cap and also
 *   accounted across the tree via ExecutionBudget; aggregate usage
 *   exceeding the budget cancels/cancels further child work. Not a
 *   hard pre-call token count.
 * - `maxCost` is a typed preflight rejection only. No provider-neutral
 *   pricing is available; requesting `maxCost` when unsupported by the
 *   runner produces a `limit_validation_error`.
 */
export interface AgentLimits {
  /** Maximum model turns before forced termination. */
  maxTurns?: number;
  /** Maximum total tokens across all model calls (provider cap + post-usage tree enforcement). */
  maxTokens?: number;
  /** Maximum estimated cost in USD (typed preflight rejection only, not enforced). */
  maxCost?: number;
  /** Hard timeout in milliseconds enforced via AbortSignal. */
  timeoutMs?: number;
  /** Maximum concurrent child agents (including nested subagents). */
  maxChildren?: number;
  /** Maximum nesting depth for child agents (0 = no children). */
  maxDepth?: number;
  /** Maximum concurrent agent children. */
  maxConcurrency?: number;
}

// ─── Run Input / Output ──────────────────────────────────────────

/** Input for a one-shot agent run. */
export interface RunInput {
  /** The task description. */
  task: string;
  /**
   * Explicit context injected into the child's instructions.
   * Accepts ordinary object literals; internally serialized with
   * stable deterministic key ordering.
   */
  context?: Record<string, unknown>;
  /**
   * Attachments the agent can inspect.
   * Currently limited to plain-text content references.
   */
  attachments?: ReadonlyArray<RunAttachment>;
  /** Structured output schema request. */
  output?: RunOutputFormat;
  /** Cancellation signal propagated from parent to child execution. */
  signal?: AbortSignal;
}

/**
 * An attachment the agent can inspect during its run.
 * Only textual MIME types are supported; binary types are rejected
 * with a typed validation error. Attachments are supplied data,
 * not filesystem references.
 */
export interface RunAttachment {
  name: string;
  content: string;
  mimeType?: string;
}

/**
 * Request for structured JSON output conforming to a JSON Schema.
 * Supported schema keywords: type, properties, required, items, enum,
 * additionalProperties. Other keywords are rejected with a typed error.
 */
export interface RunOutputFormat {
  /** JSON Schema for structured output. */
  schema: Record<string, unknown>;
  /** Human-readable name for the schema (used in tool descriptors). */
  name?: string;
}

/** Reference to an artifact produced or modified by an agent run. */
export interface ArtifactReference {
  /** Local filesystem path of the artifact. */
  path?: string;
  /** Remote URL of the artifact. */
  url?: string;
  /** Optional MIME type hint. */
  mimeType?: string;
}

/** Normalized result of a one-shot agent run. */
export interface RunResult<T = string> {
  /** Terminal status. */
  status: 'completed' | 'failed' | 'cancelled';
  /** Output text when status is completed; undefined on failure or cancel. */
  output?: T;
  /** Artifacts the agent produced or modified. */
  artifacts?: ReadonlyArray<ArtifactReference>;
  /** Token usage when available. */
  usage?: NormalizedUsage;
  /** Typed error when status is failed or cancelled. */
  error?: RunError;
}

/** Structured error from an agent run. */
export interface RunError {
  code: RunErrorCode;
  message: string;
  /** Optional cause for debugging (never exposed in public API output). */
  cause?: unknown;
}

export type RunErrorCode =
  | 'unsupported_structured_output'
  | 'unsupported_attachments'
  | 'invalid_model_policy'
  | 'unknown_skill'
  | 'unknown_tool'
  | 'permission_denied'
  | 'unsupported_permission_scope'
  | 'invalid_scope_pattern'
  | 'unsupported_limit'
  | 'limit_validation_error'
  | 'limit_exceeded'
  | 'scope_violation'
  | 'provider_error'
  | 'cancelled'
  | 'agent_error'
  | 'invalid_attachment'
  | 'invalid_schema'
  | 'invalid_output';

// ─── Tool Reference ───────────────────────────────────────────────

/**
 * Public tool name reference alias.
 *
 * MVP: a plain string matching known tool names in the Term2 tool set.
 * Future: may expand to structured references (name + config overrides).
 */
export type ToolReference = string;

// ─── Agent Config ────────────────────────────────────────────────

/** Configuration used to create an agent handle. */
export interface AgentConfig {
  /** Required agent instructions. */
  instructions: string;
  /** Optional display name (defaults to "agent"). */
  name?: string;
  /** Model selection policy. Defaults to 'balanced'. */
  model?: ModelPolicy;
  /** Requested tools available to the agent. Omitted/empty = no tools. */
  tools?: ReadonlyArray<ToolReference>;
  /** Requested skill names. */
  skills?: ReadonlyArray<string>;
  /**
   * Requested permissions. Authorizes which of the requested tools can
   * execute and derives coarse capability flags. Effective permissions
   * are intersected with parent.
   */
  permissions?: AgentPermissions;
  /** Requested limits. Effective limits are clamped by parent. */
  limits?: AgentLimits;
}

// ─── Agent Handle ────────────────────────────────────────────────

/** A configured, resolved agent ready to execute one-shot runs. */
export interface AgentHandle {
  readonly name: string;
  readonly model: { provider: string; model: string };
  readonly permissions: AgentPermissions;
  readonly limits: AgentLimits;
  run<T = string>(input: RunInput): Promise<RunResult<T>>;
}
