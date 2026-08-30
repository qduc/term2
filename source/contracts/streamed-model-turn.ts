import type { JsonSchemaDefinition } from './model-types.js';

/** Provider-owned options and metadata retained at characterized protocol boundaries. */
export type StreamedModelProviderOptions = Readonly<Record<string, unknown>>;

/** Mutable state shared by one session provider request. */
export interface ContextCompactionSessionState {
  disabled: boolean;
}

/** Codex-only request options. They are intentionally separate from opaque provider options. */
export interface StreamedModelCodexOptions {
  readonly promptCacheKey?: string;
  readonly include?: readonly string[];
}

export type StreamedModelImageReference = string | { readonly id: string };
export type StreamedModelFileReference = string | { readonly id: string } | { readonly url: string };

export type StreamedModelTextPart = { readonly type: 'text'; readonly text: string };

export type StreamedModelMessagePart =
  | StreamedModelTextPart
  | { readonly type: 'image'; readonly image?: StreamedModelImageReference; readonly detail?: string };

export type StreamedModelToolResultPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly image?:
        | string
        | { readonly id: string }
        | { readonly data: string | Uint8Array; readonly mediaType?: string }
        | { readonly url: string }
        | { readonly fileId: string };
      readonly detail?: string;
    }
  | {
      readonly type: 'file';
      readonly file:
        | string
        | { readonly data: string | Uint8Array; readonly mediaType: string; readonly filename: string }
        | { readonly url: string; readonly filename?: string }
        | { readonly id: string; readonly filename?: string };
    };

/** Codex plan usage limit window surfaced by the provider stream. */
export interface CodexRateLimitWindow {
  readonly used_percent: number;
  readonly window_minutes: number;
  readonly reset_after_seconds: number;
  readonly reset_at: number;
}

/** Codex ChatGPT plan usage limits (typically 5H primary and 7D secondary). */
export interface CodexRateLimitInfo {
  readonly allowed: boolean;
  readonly limit_reached: boolean;
  readonly primary?: CodexRateLimitWindow;
  readonly secondary?: CodexRateLimitWindow;
}

/**
 * One unary completion payload as returned by adapters that expose `getResponse`.
 *
 * Shared by the adapters that actually support the unary path: OpenAI Responses
 * returns the tagged `completion` event (`completedEvent`), which is a subtype
 * of this shape; AI SDK returns the same untagged `{ responseId, output, usage }`
 * object. Optional fields stay optional so both adapters satisfy the type as-is.
 */
export type StreamedModelUnaryResult = {
  readonly responseId: string;
  readonly output: readonly StreamedModelTurnOutput[];
  readonly usage?: StreamedModelUsage;
  readonly finishReason?: string;
  readonly costUsd?: number | string;
};

/** One application-owned streamed model invocation. */
export interface StreamedModelTurn {
  stream(request: StreamedModelTurnRequest): AsyncIterable<StreamedModelTurnEvent>;
  /** Optional unary fast path for providers whose native API is non-streaming. */
  getResponse?(request: StreamedModelTurnRequest): Promise<StreamedModelUnaryResult>;
  /**
   * Codex ChatGPT backend compact endpoint. OpenAI api.openai.com uses
   * `context_management` on create instead and does not implement this.
   */
  compactHistory?(request: {
    readonly input: readonly StreamedModelTurnInput[];
    readonly instructions?: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly history: readonly unknown[] }>;
}

export interface StreamedModelTurnRequest {
  readonly instructions?: string;
  /** Provider response to continue from when the provider supports server-side history. */
  readonly previousResponseId?: string | null;
  readonly input: readonly StreamedModelTurnInput[];
  readonly tools: readonly StreamedModelTool[];
  /** Test/runtime-local tool objects; provider adapters must not serialize this field. */
  readonly applicationTools?: readonly unknown[];
  readonly toolChoice?: 'auto' | 'required' | 'none' | { readonly name: string };
  readonly temperature?: number;
  readonly topP?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly maxTokens?: number;
  /** Structured output declaration retained for result-shaped callers. */
  readonly outputType?: JsonSchemaDefinition | 'text';
  readonly reasoning?: { readonly effort?: string | null; readonly summary?: 'auto' | 'concise' | 'detailed' | null };
  /** Codex-only settings that must never be sent through another provider's escape hatch. */
  readonly codex?: StreamedModelCodexOptions;
  readonly providerOptions?: StreamedModelProviderOptions;
  readonly signal?: AbortSignal;
  /**
   * Skip previous_response_id and transport history compression for this
   * request. Recovery uses this to send one self-contained full-history
   * inference request. A chained delta must never be retried with this flag
   * and the same input: without the anchor it is not a conversation.
   */
  readonly disableChaining?: boolean;
}

export type StreamedModelTurnInput =
  | {
      readonly type: 'message';
      readonly role: 'system';
      readonly content: readonly StreamedModelTextPart[];
    }
  | {
      readonly type: 'message';
      readonly role: 'user';
      readonly content: readonly StreamedModelMessagePart[];
    }
  | {
      readonly type: 'message';
      readonly role: 'assistant';
      readonly content: readonly StreamedModelMessagePart[];
    }
  | {
      readonly type: 'reasoning';
      readonly id?: string;
      readonly text: string;
      readonly providerMetadata?: StreamedModelProviderOptions;
    }
  | { readonly type: 'tool_call'; readonly id: string; readonly name: string; readonly arguments: string }
  | {
      readonly type: 'tool_result';
      readonly id: string;
      readonly output: string | readonly StreamedModelToolResultPart[];
    }
  | {
      /**
       * A provider-native item Term2 does not model, carried untouched across
       * the run loop. Only the provider named by `provider` may re-serialize
       * it; every other consumer must reject it explicitly.
       */
      readonly type: 'provider_opaque';
      readonly provider: string;
      readonly item: Readonly<Record<string, unknown>>;
    };

export interface StreamedModelTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
}

export type StreamedModelTurnEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'codex_rate_limits'; readonly rateLimits: CodexRateLimitInfo }
  | {
      readonly type: 'reasoning_delta';
      readonly id?: string;
      readonly text: string;
      readonly providerMetadata?: StreamedModelProviderOptions;
    }
  /** Cumulative progress while a provider is assembling a tool call's arguments. */
  | { readonly type: 'tool_call_streaming_delta'; readonly toolName?: string; readonly argumentCharCount: number }
  /**
   * Server-side context compaction, bracketed by the provider's own frames.
   *
   * A response can carry more than one compaction item (measured on OpenAI: the streamed
   * order is `[compaction, message, compaction]`), so these events can fire more than once
   * per turn. Only the last item becomes history — see `lastOpenAICompaction` — so consumers
   * must treat a later `started` as superseding an earlier pair, not as a second compaction.
   */
  | { readonly type: 'context_compaction_started'; readonly provider: string }
  | { readonly type: 'context_compaction_completed'; readonly provider: string; readonly durationMs: number }
  | { readonly type: 'tool_call'; readonly id: string; readonly name: string; readonly arguments: string }
  | {
      readonly type: 'completion';
      readonly responseId: string;
      readonly output: readonly StreamedModelTurnOutput[];
      readonly providerMetadata?: StreamedModelProviderOptions;
      readonly finishReason?: string;
      readonly usage?: StreamedModelUsage;
      /**
       * Provider-reported USD charge for this request when the provider
       * supplies one (e.g. an OpenAI-compatible cost-only trailer). Kept
       * separate from `usage` so usage normalization never drops or
       * double-counts money.
       */
      readonly costUsd?: number | string;
    };

export type StreamedModelTurnOutput =
  | { readonly type: 'message'; readonly content: readonly { readonly type: 'text'; readonly text: string }[] }
  | {
      readonly type: 'reasoning';
      readonly id?: string;
      readonly text: string;
      readonly providerMetadata?: StreamedModelProviderOptions;
    }
  | { readonly type: 'tool_call'; readonly id: string; readonly name: string; readonly arguments: string }
  | {
      /** Provider-native output item, carried untouched; see StreamedModelTurnInput. */
      readonly type: 'provider_opaque';
      readonly provider: string;
      readonly item: Readonly<Record<string, unknown>>;
    };

export interface StreamedModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
}
