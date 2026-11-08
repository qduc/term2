/**
 * model/ — providers behind one streaming interface.
 *
 * The bottom of the stack. It owns the conversation item format (what a model
 * reads and writes), provider adapters, retries and error classification.
 * Depends on: nothing.
 */

import type { RetryRecoveryBudget } from './failure/retry-recovery-budget.js';

export { ModelFailure } from './failure.js';
export type { ModelRecoveryEvidence } from './failure.js';
export type ModelRecoveryBudget = RetryRecoveryBudget;

/** Scheduling assumption only; not evidence of provider capacity. */
export const DEFAULT_ASSUMED_CONTEXT_WINDOW = 128_000;

// ---------- Conversation items (provider-neutral history) ----------

export type ItemId = string & { readonly __brand: 'ItemId' };
export type ToolCallId = string & { readonly __brand: 'ToolCallId' };

export type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: string; readonly data: string; readonly detail?: string };

/** Provider-native response items carried untouched until they return to their source provider. */
export type ProviderOpaqueItem = {
  readonly type: 'provider_opaque';
  readonly id: ItemId;
  readonly provider: string;
  readonly sourceProvider?: string;
  readonly item: Readonly<Record<string, unknown>>;
};

/** Stream inputs that the portable Item variants cannot represent exactly. */
export type ProviderInputItem = {
  readonly type: 'provider_input';
  readonly id: ItemId;
  readonly provider: string;
  readonly input: Readonly<Record<string, unknown>>;
};

export type Item =
  | {
      readonly type: 'user_message';
      readonly id: ItemId;
      readonly content: readonly ContentPart[];
      /** App-owned receipt context; serializes before this item, never orphaned by history edits. */
      readonly conversationTiming?: string;
    }
  | { readonly type: 'assistant_message'; readonly id: ItemId; readonly content: readonly ContentPart[] }
  | {
      readonly type: 'reasoning';
      readonly id: ItemId;
      readonly summary: string;
      readonly opaque?: unknown;
      readonly providerMetadata?: Readonly<Record<string, unknown>>;
      readonly providerItemId?: string;
    }
  | {
      readonly type: 'tool_call';
      readonly id: ItemId;
      readonly callId: ToolCallId;
      readonly toolName: string;
      readonly input: unknown;
      readonly rawArguments?: string;
      readonly argumentsSnapshot?: unknown;
      readonly providerMetadata?: Readonly<Record<string, unknown>>;
      readonly toolType?: 'function' | 'custom';
    }
  | {
      readonly type: 'tool_result';
      readonly id: ItemId;
      readonly callId: ToolCallId;
      readonly output: string;
      readonly isError: boolean;
      readonly providerOutput?: readonly Readonly<Record<string, unknown>>[];
      readonly toolType?: 'function' | 'custom';
    }
  | { readonly type: 'summary'; readonly id: ItemId; readonly text: string; readonly replaces: readonly ItemId[] }
  | ProviderOpaqueItem
  | ProviderInputItem;

// ---------- Requests and streamed responses ----------

export type ModelRef = { readonly provider: string; readonly model: string };

export type ToolSpec = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool input. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Provider-native custom declaration when the model uses a grammar input surface. */
  readonly modelTool?: {
    readonly type: 'custom';
    readonly format: {
      readonly type: 'grammar';
      readonly syntax: 'lark';
      readonly definition: string;
    };
  };
};

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Explicit provider identity, independent of a host's ambient session state.
 * History may rotate while cache and routing affinity remain stable. Nested
 * runs can keep their own history and physical transport scope. */
export type ModelAffinity = {
  /** Logical provider history identity. */
  readonly conversationKey: string;
  /** Stable prefix-cache hint, where supported. */
  readonly cacheKey?: string;
  /** Sticky server/transport identity; defaults to cacheKey, then conversationKey. */
  readonly routingKey?: string;
};

export type ModelRequest = {
  readonly affinity?: ModelAffinity;
  readonly model: ModelRef;
  readonly instructions: string;
  readonly input: readonly Item[];
  readonly tools: readonly ToolSpec[];
  readonly reasoning?: ReasoningEffort;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** The agent's `modelSettings.providerData`, passed to the provider as is. */
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  /** Provider-side continuation, e.g. a previous response id. Opaque to callers. */
  readonly continuation?: unknown;
  /** Explicit provider continuation accepted by source-backed model adapters. */
  readonly previousResponseId?: string | null;
  /** Send a self-contained request and suppress provider-side continuation. */
  readonly disableChaining?: boolean;
  /**
   * Live-only engine-owned reservation. Presence disables ALL adapter/SDK
   * physical retries so every dispatch re-enters engine request preparation.
   * Never serialize this capability to providers or Session facts.
   */
  readonly recovery?: { readonly budget: ModelRecoveryBudget; readonly dispatchClaimed?: boolean };
  /** OpenAI Responses standard tier; unsupported adapters reject this flag. */
  readonly useStandardServiceTier?: boolean;
  /** A self-contained HTTP request on supported WS adapters, not an implicit retry. */
  readonly downgradeTransport?: boolean;
};

export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  /** The provider an aggregator routed this request to (OpenRouter's `provider`), when it reports one. */
  readonly upstreamProvider?: string;
};

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';

/** Actual provider argument progress, not reconstructed from a completed call. */
export type ToolCallArgumentProgress = {
  readonly type: 'tool_call_streaming_delta';
  readonly argumentCharCount: number;
  readonly toolName?: string;
  /** Present only when the provider has supplied the real call ID. */
  readonly callId?: ToolCallId;
  /** Responses output item identity is not interchangeable with callId. */
  readonly itemId?: string;
  /** Provider output/tool-call stream slot, not an engine execution ordinal. */
  readonly callIndex?: number;
};

export type CodexWeeklyQuota = { readonly usedPercent: number; readonly resetAt: number };

export type ModelEvent =
  | { readonly type: 'codex_quota'; readonly quota: CodexWeeklyQuota | null }
  | ToolCallArgumentProgress
  | { readonly type: 'text_delta'; readonly delta: string; readonly partId?: string }
  | {
      readonly type: 'reasoning_delta';
      readonly delta: string;
      readonly id?: string;
      readonly providerMetadata?: Readonly<Record<string, unknown>>;
    }
  /** A complete item the model produced; the engine appends these to history. */
  | { readonly type: 'item'; readonly item: Item }
  | {
      readonly type: 'usage';
      readonly usage: Usage;
      readonly speed?: { readonly tps: number; readonly approximate: boolean };
    }
  | { readonly type: 'retrying'; readonly attempt: number; readonly delayMs: number; readonly error: ModelError }
  | {
      readonly type: 'done';
      readonly stopReason: StopReason;
      readonly continuation?: unknown;
      readonly providerMetadata?: Readonly<Record<string, unknown>>;
      readonly costUsd?: number | string;
    };

export type ModelErrorKind =
  | 'authentication'
  | 'rate_limit'
  | 'network'
  | 'context_overflow'
  | 'invalid_request'
  | 'provider'
  | 'cancelled';

export type ModelError = {
  readonly kind: ModelErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
};

export type ModelCapabilities = {
  readonly continuity: boolean;
  readonly standardServiceTier: boolean;
  readonly httpTransportDowngrade: boolean;
};

export interface Model {
  readonly ref: ModelRef;
  readonly contextWindow: number;
  /** Actual catalog capacity; absent for uncatalogued models. */
  readonly catalogContextWindow?: number;
  readonly capabilities?: ModelCapabilities;
  /** With recovery injected, one physical attempt only. Throws live ModelFailure; serialize only its ModelError fields.
   * onDispatched runs at transport submission, before any response (not generator creation).
   */
  stream(request: ModelRequest, signal: AbortSignal, onDispatched?: () => void): AsyncIterable<ModelEvent>;
  /** Native compaction where the provider supports it. */
  compact?(request: ModelRequest, signal: AbortSignal, onDispatched?: () => void): Promise<readonly Item[]>;
}

export interface ModelRegistry {
  resolve(ref: ModelRef): Model;
  list(): readonly ModelRef[];
}
