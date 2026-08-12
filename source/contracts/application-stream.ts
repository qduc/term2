import type { CodexRateLimitInfo } from './streamed-model-turn.js';
import type { ProviderInputItem } from './provider-input.js';
import type { NormalizedUsage } from '../utils/ai/token-usage.js';
import type { ModelRequestCost } from '../services/cost/model-cost.js';

/**
 * Closed event protocol consumed by the session/UI pipeline.
 * Provider and runner-specific envelopes are normalized before they cross this seam.
 */
export type ApplicationRunEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'reasoning_delta'; readonly text: string }
  | { readonly type: 'codex_rate_limits'; readonly rateLimits: CodexRateLimitInfo }
  | { readonly type: 'tool_call_streaming_delta'; readonly toolName?: string; readonly argumentCharCount: number }
  /** Server-side context compaction bracketed by real provider frames; see StreamedModelTurnEvent. */
  | {
      readonly type: 'context_compaction_started';
      readonly provider: string;
      readonly strategy?: 'native' | 'local';
    }
  | {
      readonly type: 'context_compaction_completed';
      readonly provider: string;
      readonly durationMs: number;
      readonly strategy?: 'native' | 'local';
    }
  | {
      readonly type: 'context_compaction_failed';
      readonly provider: string;
      readonly durationMs: number;
      readonly strategy: 'local';
    }
  | { readonly type: 'item'; readonly item: ProviderInputItem }
  | { readonly type: 'usage_update'; readonly usage: NormalizedUsage }
  /** One settled cost record per dispatched model request, emitted as soon as it is known. */
  | { readonly type: 'cost_update'; readonly record: ModelRequestCost };

export type ApplicationRunStream = AsyncIterable<ApplicationRunEvent>;
