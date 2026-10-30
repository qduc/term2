/**
 * model/ — providers behind one streaming interface.
 *
 * The bottom of the stack. It owns the conversation item format (what a model
 * reads and writes), provider adapters, retries and error classification.
 * Depends on: nothing.
 */

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
  | { readonly type: 'user_message'; readonly id: ItemId; readonly content: readonly ContentPart[] }
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

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export type ModelRequest = {
  readonly model: ModelRef;
  readonly instructions: string;
  readonly input: readonly Item[];
  readonly tools: readonly ToolSpec[];
  readonly reasoning?: ReasoningEffort;
  readonly maxOutputTokens?: number;
  /** Provider-side continuation, e.g. a previous response id. Opaque to callers. */
  readonly continuation?: unknown;
  /** Explicit provider continuation accepted by source-backed model adapters. */
  readonly previousResponseId?: string | null;
  /** Send a self-contained request and suppress provider-side continuation. */
  readonly disableChaining?: boolean;
};

export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
};

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';

export type ModelEvent =
  | { readonly type: 'text_delta'; readonly delta: string; readonly partId?: string }
  | {
      readonly type: 'reasoning_delta';
      readonly delta: string;
      readonly id?: string;
      readonly providerMetadata?: Readonly<Record<string, unknown>>;
    }
  /** A complete item the model produced; the engine appends these to history. */
  | { readonly type: 'item'; readonly item: Item }
  | { readonly type: 'usage'; readonly usage: Usage }
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

export interface Model {
  readonly ref: ModelRef;
  readonly contextWindow: number;
  /** Retries retryable errors internally and reports them as `retrying` events. Throws `ModelError` when it gives up. */
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  /** Native compaction where the provider supports it. */
  compact?(request: ModelRequest, signal: AbortSignal): Promise<readonly Item[]>;
}

export interface ModelRegistry {
  resolve(ref: ModelRef): Model;
  list(): readonly ModelRef[];
}
