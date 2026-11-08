/** Provider events translated at the ModelRegistry boundary, independent of registry lifetime. */
import type { StreamedModelTurnEvent } from '../../streamed-model-turn.js';
import type { ModelEvent, ModelError, ToolCallId } from '../../index.js';
import { weeklyQuota } from '../../provider-quota.js';
import { extractAiSdkUpstreamProvider } from '../ai-sdk-streamed-model.js';
import { StreamingSpeedTracker } from '../../../shared/utils/streaming/streaming-speed-tracker.js';
import { outputToItem, toUsage, stopReason } from '../../provider-items.js';

export type ResponseIdentity = {
  readonly kind: 'direct_response';
  readonly owner: string;
  readonly provider: string;
  readonly model: string;
  readonly transport: string;
};
export type ResponseContinuation = ResponseIdentity & { readonly responseId: string };

// ---------- Provider stream -> ModelEvent ----------

/** Maps one received event at a time; the provider boundary owns the async iterator. */
export class ModelEventProjection {
  readonly #streamedToolCalls = new Map<string, Extract<StreamedModelTurnEvent, { type: 'tool_call' }>>();
  #completed = false;
  readonly #speed = new StreamingSpeedTracker();
  #streamedReasoning = false;

  constructor(readonly providerId: string, readonly continuation?: ResponseIdentity) {}

  *project(event: StreamedModelTurnEvent): Generator<ModelEvent> {
    switch (event.type) {
      case 'codex_rate_limits':
        if (this.providerId === 'codex') yield { type: 'codex_quota', quota: weeklyQuota(event.rateLimits) };
        break;
      case 'text_delta':
        this.#speed.recordDelta(event.text);
        yield { type: 'text_delta', delta: event.text, ...(event.partId ? { partId: event.partId } : {}) };
        break;
      case 'reasoning_delta':
        if (event.text) this.#streamedReasoning = true;
        this.#speed.recordDelta(event.text);
        yield {
          type: 'reasoning_delta',
          delta: event.text,
          ...(event.id ? { id: event.id } : {}),
          ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}),
        };
        break;
      case 'tool_call_streaming_delta':
        this.#speed.recordCumulativeChars(event.argumentCharCount);
        yield {
          type: 'tool_call_streaming_delta',
          argumentCharCount: event.argumentCharCount,
          ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
          ...(event.callId !== undefined ? { callId: event.callId as ToolCallId } : {}),
          ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
          ...(event.callIndex !== undefined ? { callIndex: event.callIndex } : {}),
        };
        break;
      case 'tool_call':
        // The completion's output is authoritative. Keep the streamed call as a fallback.
        this.#streamedToolCalls.set(event.id, event);
        break;
      case 'completion': {
        this.#completed = true;
        if (event.usage) {
          const measured = this.#speed.getSettledTps({
            completionTokens: event.usage.outputTokens,
            reasoningTokens: this.#streamedReasoning ? undefined : event.usage.reasoningTokens,
          });
          // Legacy application-run-loop: the upstream an aggregator reports rides on the request's usage.
          const upstreamProvider = extractAiSdkUpstreamProvider(event.providerMetadata);
          yield {
            type: 'usage',
            usage: { ...toUsage(event.usage), ...(upstreamProvider ? { upstreamProvider } : {}) },
            ...(measured && measured.decodeWindowMs == null
              ? { speed: { tps: measured.tps, approximate: measured.approximate } }
              : {}),
          };
        }
        const completedToolCalls = new Set<string>();
        for (const output of event.output) {
          if (output.type === 'tool_call') {
            const streamed = this.#streamedToolCalls.get(output.id);
            if (streamed) completedToolCalls.add(output.id);
            const merged = streamed
              ? {
                  ...streamed,
                  ...output,
                  ...(output.providerMetadata !== undefined || streamed.providerMetadata === undefined
                    ? {}
                    : { providerMetadata: streamed.providerMetadata }),
                  ...(streamed.toolType ? { toolType: streamed.toolType } : {}),
                }
              : output;
            yield { type: 'item', item: outputToItem(merged, this.providerId) };
            continue;
          }
          yield { type: 'item', item: outputToItem(output, this.providerId) };
        }
        for (const [callId, streamed] of this.#streamedToolCalls) {
          if (!completedToolCalls.has(callId)) yield { type: 'item', item: outputToItem(streamed, this.providerId) };
        }
        yield {
          type: 'done',
          stopReason: stopReason(event.finishReason),
          ...(this.continuation && event.responseId
            ? { continuation: { ...this.continuation, responseId: event.responseId } satisfies ResponseContinuation }
            : {}),
          ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}),
          ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        };
        break;
      }
      default:
        break;
    }
  }

  finish(): void {
    // A stream that ends without its completion is a failure, not a finished answer.
    if (!this.#completed) {
      const truncated: ModelError = {
        kind: 'network',
        message: 'Model stream ended before the response completed.',
        retryable: false,
      };
      throw truncated;
    }
  }
}
