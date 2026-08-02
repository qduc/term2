/** Provider-owned options and metadata retained at characterized protocol boundaries. */
export type StreamedModelProviderOptions = Readonly<Record<string, unknown>>;

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

/** One application-owned streamed model invocation. */
export interface StreamedModelTurn {
  stream(request: StreamedModelTurnRequest): AsyncIterable<StreamedModelTurnEvent>;
  /** Optional unary fast path for providers whose native API is non-streaming. */
  getResponse?(request: StreamedModelTurnRequest): Promise<any>;
}

export interface StreamedModelTurnRequest {
  readonly instructions?: string;
  /** Provider response to continue from when the provider supports server-side history. */
  readonly previousResponseId?: string | null;
  readonly input: readonly StreamedModelTurnInput[];
  readonly tools: readonly StreamedModelTool[];
  readonly toolChoice?: 'auto' | 'required' | 'none' | { readonly name: string };
  readonly temperature?: number;
  readonly topP?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly maxTokens?: number;
  readonly reasoning?: { readonly effort?: string | null; readonly summary?: 'auto' | 'concise' | 'detailed' | null };
  /** Codex-only settings that must never be sent through another provider's escape hatch. */
  readonly codex?: StreamedModelCodexOptions;
  readonly providerOptions?: StreamedModelProviderOptions;
  readonly signal?: AbortSignal;
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
  | { readonly type: 'tool_call'; readonly id: string; readonly name: string; readonly arguments: string }
  | {
      readonly type: 'completion';
      readonly responseId: string;
      readonly output: readonly StreamedModelTurnOutput[];
      readonly providerMetadata?: StreamedModelProviderOptions;
      readonly finishReason?: string;
      readonly usage?: StreamedModelUsage;
    };

export type StreamedModelTurnOutput =
  | { readonly type: 'message'; readonly content: readonly { readonly type: 'text'; readonly text: string }[] }
  | {
      readonly type: 'reasoning';
      readonly id?: string;
      readonly text: string;
      readonly providerMetadata?: StreamedModelProviderOptions;
    }
  | { readonly type: 'tool_call'; readonly id: string; readonly name: string; readonly arguments: string };

export interface StreamedModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
}
