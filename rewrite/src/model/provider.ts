/**
 * Real providers behind `ModelRegistry`, without the adopted adapter. The only
 * place that sees provider shapes: `Item` converts here and nowhere else.
 *
 * `resolve` is synchronous and source `createStreamedModel` is not, so the
 * returned `Model` creates the provider model on first `stream`.
 *
 * Settings map as the run loop maps them: temperature, `reasoning` as the agent
 * factory's `{ effort, summary: 'auto' }`, `maxOutputTokens` as `maxTokens`,
 * `providerOptions` as given, and the prompt cache key where `getAgent` puts it.
 * The cache key comes from the ambient session context (`getContext()`), which
 * the caller sets around the turn; a request carries no conversation id.
 *
 * History is `Item[]` from facts, so every request is self-contained
 * (`disableChaining`). A provider's remembered response ids are never used.
 */

import { randomUUID } from 'node:crypto';
import type {
  ContextCompactionSessionState,
  StreamedModelToolDefinition,
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnInput,
  StreamedModelTurnOutput,
  StreamedModelTurnRequest,
  StreamedModelUsage,
} from '../../../source/contracts/streamed-model-turn.js';
import type {
  ILoggingService,
  ISessionContextService,
  ISettingsService,
  SessionTrafficContext,
} from '../../../source/services/service-interfaces.js';
import type { ProviderDefinition } from '../../../source/providers/registry.js';
import { getProvider } from '../../../source/providers/index.js';
import { getModelContextWindow } from '../../../source/providers/model-catalog/catalog.js';
import { MODEL_CATALOG } from '../../../source/providers/model-catalog/catalog.generated.js';
import { isAbortLikeError } from '../../../source/utils/error-helpers.js';
import type {
  Item,
  ItemId,
  Model,
  ModelError,
  ModelErrorKind,
  ModelEvent,
  ModelRef,
  ModelRegistry,
  ModelRequest,
  StopReason,
  ToolCallId,
  ToolSpec,
  Usage,
} from './index.js';

export type ProviderRegistryDeps = {
  readonly settings: ISettingsService;
  readonly logger: ILoggingService;
  readonly sessionContext: ISessionContextService;
};

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_RETRY_ATTEMPTS = 2;

export function createProviderRegistry(deps: ProviderRegistryDeps): ModelRegistry {
  const models = new Map<string, Model>();
  // Process-wide, as the run loop keeps it per session: once a provider rejects
  // server-side compaction, the option is dropped from later requests.
  const compaction: ContextCompactionSessionState = { disabled: false };
  return {
    resolve(ref) {
      const key = `${ref.provider}\u0000${ref.model}`;
      const cached = models.get(key);
      if (cached) return cached;
      const provider = getProvider(ref.provider);
      if (!provider?.createStreamedModel) {
        throw new Error(`Provider '${ref.provider}' does not expose an application streamed model.`);
      }
      const model = lazyModel(ref, provider, deps, compaction);
      models.set(key, model);
      return model;
    },
    list() {
      return Object.entries(MODEL_CATALOG as Record<string, Record<string, unknown>>).flatMap(([provider, catalog]) =>
        getProvider(provider) ? Object.keys(catalog).map((model) => ({ provider, model })) : [],
      );
    },
  };
}

function lazyModel(
  ref: ModelRef,
  provider: ProviderDefinition,
  deps: ProviderRegistryDeps,
  compaction: ContextCompactionSessionState,
): Model {
  let created: Promise<StreamedModelTurn> | undefined;
  // A failed creation is not cached, so the next turn tries again.
  const turnModel = (): Promise<StreamedModelTurn> => {
    created ??= Promise.resolve(
      provider.createStreamedModel!(ref.model, {
        settingsService: deps.settings,
        loggingService: deps.logger,
        sessionContextService: deps.sessionContext,
        retryAttempts: deps.settings.get('agent.retryAttempts') ?? DEFAULT_RETRY_ATTEMPTS,
        contextCompactionSessionState: compaction,
      }),
    ).catch((error: unknown) => {
      created = undefined;
      throw error;
    });
    return created;
  };
  return {
    ref,
    contextWindow: getModelContextWindow(ref.provider, ref.model) ?? DEFAULT_CONTEXT_WINDOW,
    async *stream(request, signal) {
      // Also aborted when the consumer stops early (a tool call ends the turn), so the
      // HTTP request does not outlive the turn. Returning from a generator alone does not close it.
      const stopped = new AbortController();
      const linked = AbortSignal.any([signal, stopped.signal]);
      try {
        // Nothing reaches the provider once the turn is already cancelled.
        if (signal.aborted) throw abortError();
        // Read in the stream body, so the caller's context (set around the turn) applies.
        const context = deps.sessionContext.getContext();
        const turn = await turnModel();
        const providerRequest = toProviderRequest(request, linked, { provider, ref, context, compaction });
        yield* modelEvents(turn, providerRequest, ref.provider, linked);
      } catch (error) {
        throw toModelError(error, signal);
      } finally {
        stopped.abort();
      }
    },
  };
}

function toProviderRequest(
  request: ModelRequest,
  signal: AbortSignal,
  scope: {
    readonly provider: ProviderDefinition;
    readonly ref: ModelRef;
    readonly context: SessionTrafficContext | null;
    readonly compaction: ContextCompactionSessionState;
  },
): StreamedModelTurnRequest {
  const { provider, ref, context, compaction } = scope;
  let providerOptions: Record<string, unknown> | undefined = request.providerOptions
    ? { ...request.providerOptions }
    : undefined;
  if (providerOptions && compaction.disabled) delete providerOptions.contextCompaction;

  // Mirrors `getAgent` (cache key) and `toApplicationCodexSettings` (codex). Other
  // placements are dropped there too, so the run loop never sends them.
  const cacheKey =
    context && provider.capabilities?.supportsPromptCacheKey ? context.promptCacheKey ?? context.sessionId : undefined;
  const extraBodyKey = provider.capabilities?.promptCacheKeyPlacement === 'responses-extra-body';
  if (cacheKey && extraBodyKey) {
    const extraBody = isRecord(providerOptions?.extraBody) ? providerOptions.extraBody : {};
    providerOptions = { ...providerOptions, extraBody: { ...extraBody, prompt_cache_key: cacheKey } };
  }
  // `store` and `include` are not in TurnSpec: they come from the provider's defaults,
  // which the agent factory merges into top-level modelSettings. Only codex reads
  // `include`, and the run loop never reads `store`.
  let codex: { promptCacheKey?: string; include?: readonly string[] } | undefined;
  if (ref.provider === 'codex') {
    const promptCacheKey = cacheKey && !extraBodyKey ? cacheKey : undefined;
    const include = stringArray(provider.defaultModelSettings?.().include);
    if (promptCacheKey !== undefined || include !== undefined) {
      codex = {
        ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
        ...(include !== undefined ? { include } : {}),
      };
    }
  }

  return {
    instructions: request.instructions,
    input: request.input.map(itemToInput),
    tools: request.tools.map(toolDefinition),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.reasoning ? { reasoning: { effort: request.reasoning, summary: 'auto' as const } } : {}),
    ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {}),
    ...(codex ? { codex } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    signal,
    disableChaining: true,
  };
}

function toolDefinition(tool: ToolSpec): StreamedModelToolDefinition {
  return tool.modelTool
    ? {
        type: tool.modelTool.type,
        name: tool.name,
        description: tool.description,
        format: tool.modelTool.format,
      }
    : {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      };
}

// ---------- Item -> provider input ----------

function itemToInput(item: Item): StreamedModelTurnInput {
  switch (item.type) {
    case 'user_message':
    case 'assistant_message':
      return {
        type: 'message',
        role: item.type === 'user_message' ? 'user' : 'assistant',
        content: item.content.map((part) =>
          part.type === 'text'
            ? { type: 'text' as const, text: part.text }
            : {
                type: 'image' as const,
                image: `data:${part.mediaType};base64,${part.data}`,
                ...(part.detail ? { detail: part.detail } : {}),
              },
        ),
      };
    case 'reasoning':
      return {
        type: 'reasoning',
        ...(item.providerItemId !== undefined ? { id: item.providerItemId } : {}),
        text: item.summary,
        ...(item.providerMetadata ? { providerMetadata: item.providerMetadata } : {}),
      };
    case 'provider_opaque':
      return {
        type: 'provider_opaque',
        provider: item.provider,
        ...(item.sourceProvider ? { sourceProvider: item.sourceProvider } : {}),
        item: item.item,
      };
    case 'provider_input':
      return item.input as unknown as StreamedModelTurnInput;
    case 'tool_call':
    case 'tool_result':
    case 'summary':
      // M1 never persists these: a model tool call fails the turn before it is committed.
      throw new Error(`Item '${item.type}' has no provider input at M1`);
  }
}

// ---------- Provider stream -> ModelEvent ----------

async function* modelEvents(
  turn: StreamedModelTurn,
  request: StreamedModelTurnRequest,
  providerId: string,
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  const streamedToolCalls = new Map<string, Extract<StreamedModelTurnEvent, { type: 'tool_call' }>>();
  let completed = false;
  try {
    for await (const event of turn.stream(request)) {
      if (signal.aborted) throw abortError();
      switch (event.type) {
        case 'text_delta':
          yield { type: 'text_delta', delta: event.text, ...(event.partId ? { partId: event.partId } : {}) };
          break;
        case 'reasoning_delta':
          yield {
            type: 'reasoning_delta',
            delta: event.text,
            ...(event.id ? { id: event.id } : {}),
            ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}),
          };
          break;
        case 'tool_call':
          // The completion's output is authoritative. Keep the streamed call as a fallback.
          streamedToolCalls.set(event.id, event);
          break;
        case 'completion': {
          completed = true;
          if (event.usage) yield { type: 'usage', usage: toUsage(event.usage) };
          const completedToolCalls = new Set<string>();
          for (const output of event.output) {
            if (output.type === 'tool_call') {
              const streamed = streamedToolCalls.get(output.id);
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
              yield { type: 'item', item: outputToItem(merged, providerId) };
              continue;
            }
            yield { type: 'item', item: outputToItem(output, providerId) };
          }
          for (const [callId, streamed] of streamedToolCalls) {
            if (!completedToolCalls.has(callId)) yield { type: 'item', item: outputToItem(streamed, providerId) };
          }
          yield {
            type: 'done',
            stopReason: stopReason(event.finishReason),
            continuation: event.responseId,
            ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}),
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
          };
          break;
        }
        default:
          break;
      }
    }
    // A stream that ends without its completion is a failure, not a finished answer.
    if (!completed) {
      const truncated: ModelError = {
        kind: 'network',
        message: 'Model stream ended before the response completed.',
        retryable: false,
      };
      throw truncated;
    }
  } catch (error) {
    throw toModelError(error, signal);
  }
}

function outputToItem(
  output: StreamedModelTurnOutput | Extract<StreamedModelTurnEvent, { type: 'tool_call' }>,
  providerId: string,
): Item {
  switch (output.type) {
    case 'message':
      return { type: 'assistant_message', id: newItemId(), content: output.content.map((part) => ({ ...part })) };
    case 'reasoning':
      return {
        type: 'reasoning',
        id: output.id ? (output.id as ItemId) : newItemId(),
        ...(output.id !== undefined ? { providerItemId: output.id } : {}),
        summary: output.text,
        ...(output.providerMetadata ? { providerMetadata: output.providerMetadata } : {}),
      };
    case 'tool_call': {
      const parsed = parseArguments(output.arguments);
      return {
        type: 'tool_call',
        id: output.id ? (output.id as ItemId) : newItemId(),
        callId: output.id as ToolCallId,
        toolName: output.name,
        input: parsed,
        rawArguments: output.arguments,
        argumentsSnapshot: parsed,
        ...(output.providerMetadata ? { providerMetadata: output.providerMetadata } : {}),
        ...('toolType' in output && output.toolType ? { toolType: output.toolType } : {}),
      };
    }
    case 'provider_opaque':
      return {
        type: 'provider_opaque',
        id: newItemId(),
        provider: output.provider || providerId,
        ...(output.sourceProvider ? { sourceProvider: output.sourceProvider } : {}),
        item: output.item,
      };
  }
}

function toUsage(usage: StreamedModelUsage): Usage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
  };
}

function stopReason(reason: string | undefined): StopReason {
  if (reason === 'tool_calls' || reason === 'tool_use' || reason === 'function_call') return 'tool_use';
  if (reason === 'length' || reason === 'max_tokens') return 'max_tokens';
  if (reason === 'content_filter' || reason === 'refusal') return 'refusal';
  return 'end_turn';
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ---------- Errors ----------

/**
 * Maps a provider failure onto `ModelError`. The message is the provider's own
 * body message when it has one (`500 boom` becomes `boom`), so it matches what
 * the old CLI printed. Retries already happened in `RetryingModel` or the SDK.
 */
function toModelError(error: unknown, signal?: AbortSignal): ModelError {
  if (isModelError(error)) return error;
  const message = messageOf(error);
  if (signal?.aborted || isAbortLikeError(error)) return { kind: 'cancelled', message, retryable: false };
  const status = statusOf(error);
  const kind = kindOf(status, message, error);
  return {
    kind,
    message,
    retryable: kind === 'rate_limit' || kind === 'network' || (status !== undefined && status >= 500),
  };
}

function kindOf(status: number | undefined, message: string, error: unknown): ModelErrorKind {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if ((status === 400 || status === 413) && /context[ _](length|window)|too many tokens/i.test(message)) {
    return 'context_overflow';
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) return 'invalid_request';
  if (status === undefined && isConnectionError(error, message)) return 'network';
  return 'provider';
}

function isConnectionError(error: unknown, message: string): boolean {
  const name = isRecord(error) && typeof error.name === 'string' ? error.name : '';
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  return (
    name === 'APIConnectionError' ||
    name === 'APIConnectionTimeoutError' ||
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) ||
    /connection error|fetch failed|socket hang up|terminated|premature close|ended before the response/i.test(message)
  );
}

function messageOf(error: unknown): string {
  if (isRecord(error) && isRecord(error.error) && typeof error.error.message === 'string') return error.error.message;
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}

function statusOf(error: unknown): number | undefined {
  return isRecord(error) && typeof error.status === 'number' ? error.status : undefined;
}

function isModelError(value: unknown): value is ModelError {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean'
  );
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

// ---------- Helpers ----------

function newItemId(): ItemId {
  return `item_${randomUUID()}` as ItemId;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The string entries of an array setting, as `toApplicationCodexSettings` keeps them. */
function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined;
}
