import type { CodexRateLimitInfo } from './streamed-model-turn.js';
import type { ProviderInputItem } from './provider-input.js';
import type { NormalizedUsage } from '../utils/ai/token-usage.js';

/**
 * Closed event protocol consumed by the session/UI pipeline.
 * Provider and runner-specific envelopes are normalized before they cross this seam.
 */
export type ApplicationRunEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'reasoning_delta'; readonly text: string }
  | { readonly type: 'codex_rate_limits'; readonly rateLimits: CodexRateLimitInfo }
  | { readonly type: 'tool_call_streaming_delta'; readonly toolName?: string; readonly argumentCharCount: number }
  | { readonly type: 'item'; readonly item: ProviderInputItem }
  | { readonly type: 'usage_update'; readonly usage: NormalizedUsage };

export type ApplicationRunStream = AsyncIterable<ApplicationRunEvent>;
