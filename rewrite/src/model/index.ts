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
  | { readonly type: 'image'; readonly mediaType: string; readonly data: string };

export type Item =
  | { readonly type: 'user_message'; readonly id: ItemId; readonly content: readonly ContentPart[] }
  | { readonly type: 'assistant_message'; readonly id: ItemId; readonly content: readonly ContentPart[] }
  | { readonly type: 'reasoning'; readonly id: ItemId; readonly summary: string; readonly opaque?: unknown }
  | {
      readonly type: 'tool_call';
      readonly id: ItemId;
      readonly callId: ToolCallId;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool_result';
      readonly id: ItemId;
      readonly callId: ToolCallId;
      readonly output: string;
      readonly isError: boolean;
    }
  /** Replaces a span of earlier items after compaction. */
  | { readonly type: 'summary'; readonly id: ItemId; readonly text: string; readonly replaces: readonly ItemId[] };

// ---------- Requests and streamed responses ----------

export type ModelRef = { readonly provider: string; readonly model: string };

export type ToolSpec = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool input. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
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
};

export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
};

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';

export type ModelEvent =
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'reasoning_delta'; readonly delta: string }
  /** A complete item the model produced; the engine appends these to history. */
  | { readonly type: 'item'; readonly item: Item }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'retrying'; readonly attempt: number; readonly delayMs: number; readonly error: ModelError }
  | { readonly type: 'done'; readonly stopReason: StopReason; readonly continuation?: unknown };

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
