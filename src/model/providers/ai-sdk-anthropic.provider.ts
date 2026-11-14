import type { SharedV3ProviderOptions } from '@ai-sdk/provider';
import { createAnthropic, type AnthropicProviderSettings } from '@ai-sdk/anthropic';
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';
import {
  forwardExplicitProviderSettings,
  withForwardedProviderSettings,
  resolveThinkingBudget,
} from './ai-sdk-provider-settings.js';
import { createAiSdkStreamedModel } from './ai-sdk-streamed-model.js';
import type { StreamedModelTurn, StreamedModelTurnInput, StreamedModelTurnRequest } from '../streamed-model-turn.js';

type AiSdkAnthropicModelLike = LanguageModelV3;

export type AnthropicPromptCachingPredicate = (modelId: string) => boolean;

function defaultAnthropicPromptCachingPredicate(modelId: string): boolean {
  const lowerModelId = modelId.toLowerCase();
  return lowerModelId.includes('anthropic') || lowerModelId.includes('claude');
}

export function addAnthropicPromptCachingToMessages(
  messages: any[],
  modelId?: string,
  shouldApplyPromptCaching: AnthropicPromptCachingPredicate = defaultAnthropicPromptCachingPredicate,
): any[] {
  if (!Array.isArray(messages) || messages.length === 0 || !modelId || !shouldApplyPromptCaching(modelId)) {
    return messages;
  }

  const next = messages.map((message) => ({ ...message }));

  const markMessage = (index: number): void => {
    const message = next[index];
    if (!message) return;

    message.providerOptions = {
      ...message.providerOptions,
      anthropic: {
        ...(message.providerOptions?.anthropic ?? {}),
        cacheControl: { type: 'ephemeral' },
      },
    };
  };

  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role === 'system') {
      markMessage(i);
      break;
    }
  }

  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role === 'user') {
      markMessage(i);
      break;
    }
  }

  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role === 'tool') {
      markMessage(i);
      break;
    }
  }

  return next;
}

function createAnthropicPromptCachingMiddleware(
  shouldApplyPromptCaching: AnthropicPromptCachingPredicate,
): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: ({ params, model }: any): any => {
      const input = params as any;
      if (!Array.isArray(input?.messages) && !Array.isArray(input?.prompt)) {
        return input;
      }

      const modelId = typeof model === 'string' ? model : model?.modelId;
      const next = {
        ...input,
        ...(Array.isArray(input.messages)
          ? { messages: addAnthropicPromptCachingToMessages(input.messages, modelId, shouldApplyPromptCaching) }
          : {}),
        ...(Array.isArray(input.prompt)
          ? { prompt: addAnthropicPromptCachingToMessages(input.prompt, modelId, shouldApplyPromptCaching) }
          : {}),
      };
      return modelId && shouldApplyPromptCaching(modelId) ? cacheToolPrefix(next) : next;
    },
  };
}

/** Cache the stable tool prefix even when later system context changes. */
function cacheToolPrefix(params: LanguageModelV3CallOptions): LanguageModelV3CallOptions {
  if (!Array.isArray(params.prompt)) return params;
  const tools = params.tools;
  const last = tools?.at(-1);
  const cacheControl = (options: SharedV3ProviderOptions | undefined) =>
    options?.anthropic?.cacheControl ?? options?.anthropic?.cache_control;
  // Keep caller-owned tool breakpoints and automatic caching unchanged. The
  // SDK cannot attach this metadata to provider-defined tools.
  if (!tools || !last || last.type !== 'function' || cacheControl(params.providerOptions)) return params;
  if (tools.some((tool) => tool.type === 'function' && cacheControl(tool.providerOptions))) return params;
  const messageBreakpoints = params.prompt.flatMap((message) => [
    message.providerOptions,
    ...(Array.isArray(message.content) ? message.content.map((part) => part.providerOptions) : []),
  ]);
  const controls = messageBreakpoints.map(cacheControl).filter(Boolean);
  // Anthropic requires 1h breakpoints before 5m breakpoints. Do not insert a
  // short-lived tool breakpoint ahead of a caller's long-lived message cache.
  if (
    controls.length >= 4 ||
    controls.some((control) => control && typeof control === 'object' && 'ttl' in control && control.ttl === '1h')
  )
    return params;
  return {
    ...params,
    tools: tools.map((tool, index) =>
      index === tools.length - 1 && tool.type === 'function'
        ? {
            ...tool,
            providerOptions: {
              ...tool.providerOptions,
              anthropic: { ...tool.providerOptions?.anthropic, cacheControl: { type: 'ephemeral' } },
            },
          }
        : tool,
    ),
  };
}

const MAX_OUTPUT_TOKENS_MAP: Record<string, number> = {
  'minimax-m3': 131072,
  'qwen3.5-plus': 65536,
  'mimo-v2-omni': 128000,
  'kimi-k2.6': 65536,
  'qwen3.7-max': 65536,
  'qwen3.6-plus': 65536,
  'minimax-m2.7': 131072,
  'deepseek-v4-flash': 384000,
  'glm-5': 32768,
  'minimax-m2.5': 65536,
  'mimo-v2-pro': 128000,
  'qwen3.7-plus': 65536,
  'mimo-v2.5': 128000,
  'deepseek-v4-pro': 384000,
  'kimi-k2.5': 65536,
  'glm-5.1': 32768,
  'mimo-v2.5-pro': 128000,
};

export function getMaxOutputTokens(modelId: string): number {
  const defaultLimit = 65536;
  if (!modelId) return defaultLimit;
  const key = modelId.split('/').pop()?.toLowerCase() ?? '';
  return MAX_OUTPUT_TOKENS_MAP[key] ?? defaultLimit;
}

function withAnthropicPromptCaching<T extends AiSdkAnthropicModelLike>(
  model: T,
  shouldApplyPromptCaching: AnthropicPromptCachingPredicate,
  modelId: string,
): T {
  const maxOutputTokens = getMaxOutputTokens(modelId);
  return wrapLanguageModel({
    model: model as any,
    middleware: [
      {
        specificationVersion: 'v3',
        // The catalog value is a safety ceiling, not an instruction to expand
        // an explicit caller limit. Preserve a lower requested limit and cap an
        // excessive request to the model's known maximum.
        transformParams: async ({ params }) => ({
          ...params,
          maxOutputTokens:
            params.maxOutputTokens === undefined ? maxOutputTokens : Math.min(params.maxOutputTokens, maxOutputTokens),
        }),
      },
      createAnthropicPromptCachingMiddleware(shouldApplyPromptCaching),
    ],
  }) as unknown as T;
}

export type AiSdkAnthropicConfig = Pick<
  AnthropicProviderSettings,
  'baseURL' | 'apiKey' | 'authToken' | 'headers' | 'fetch' | 'name'
>;

export type AiSdkAnthropicProviderFactory = (options: AiSdkAnthropicConfig) => (modelId: string) => any;

export class AiSdkAnthropicProvider {
  #defaultModel: string;
  #resolveConfig: () => AiSdkAnthropicConfig;
  #createProvider: AiSdkAnthropicProviderFactory;
  #shouldApplyPromptCaching: AnthropicPromptCachingPredicate;

  constructor(deps: {
    defaultModel: string;
    resolveConfig: () => AiSdkAnthropicConfig;
    createProvider?: AiSdkAnthropicProviderFactory;
    shouldApplyPromptCaching?: AnthropicPromptCachingPredicate;
  }) {
    this.#defaultModel = deps.defaultModel;
    this.#resolveConfig = deps.resolveConfig;
    this.#createProvider = deps.createProvider ?? (createAnthropic as AiSdkAnthropicProviderFactory);
    this.#shouldApplyPromptCaching = deps.shouldApplyPromptCaching ?? defaultAnthropicPromptCachingPredicate;
  }

  getStreamedModel(modelName?: string): StreamedModelTurn {
    const config = this.#resolveConfig();
    const baseFetch = config.fetch;
    const provider = this.#createProvider({
      ...config,
      // Inert unless a request carries a per-message effort marker.
      fetch: withAnthropicEffortMessages((input, init) => (baseFetch ?? fetch)(input, init)),
    });
    const resolvedModelName = modelName || this.#defaultModel;
    const model = withAnthropicPromptCaching(
      provider(resolvedModelName),
      this.#shouldApplyPromptCaching,
      resolvedModelName,
    );
    const adaptiveThinking = /^claude-(?:haiku|sonnet)-5-5(?:-|$)/.test(resolvedModelName);

    const turn = createAiSdkStreamedModel(
      withForwardedProviderSettings(model, (options) => forwardExplicitProviderSettings(options, 'anthropic')),
      (request) => resolveReasoningOptions(request, adaptiveThinking),
    );
    return {
      ...turn,
      ...(turn.getResponse
        ? {
            getResponse: (request) =>
              turn.getResponse!(withEffortSentinels(withPinnedEffortFallback(request, adaptiveThinking))),
          }
        : {}),
      stream: (request) => turn.stream(withEffortSentinels(withPinnedEffortFallback(request, adaptiveThinking))),
    };
  }
}

/**
 * Per-message effort needs adaptive thinking driven by the selected effort. When the
 * caller pins thinking or effort through provider options, or the model has no
 * adaptive thinking, the markers cannot apply: send today's request instead, with
 * the effective effort top-level.
 */
function withPinnedEffortFallback(
  request: StreamedModelTurnRequest,
  adaptiveThinking: boolean,
): StreamedModelTurnRequest {
  const markers = request.input.filter((item) => item.type === 'effort_update');
  if (!markers.length) return request;
  const anthropic = (request.providerOptions as SharedV3ProviderOptions | undefined)?.anthropic;
  if (adaptiveThinking && anthropic?.thinking === undefined && anthropic?.effort === undefined) return request;
  const effective = request.conversationEffort ?? markers.at(-1)!.effort;
  const { conversationEffort: _effective, ...rest } = request;
  return {
    ...rest,
    input: request.input.filter((item) => item.type !== 'effort_update'),
    reasoning: { ...request.reasoning, effort: effective },
  };
}

/** Apply anthropic's reasoning options before crossing the SDK boundary. */
function resolveReasoningOptions(
  request: StreamedModelTurnRequest,
  adaptiveThinking: boolean,
): SharedV3ProviderOptions | undefined {
  const budget = resolveThinkingBudget(request.reasoning?.effort);
  if (budget === undefined) return request.providerOptions as SharedV3ProviderOptions | undefined;
  const providerOptions: SharedV3ProviderOptions = {
    ...(request.providerOptions as SharedV3ProviderOptions | undefined),
  };
  providerOptions.anthropic = {
    ...(providerOptions.anthropic ?? {}),
    thinking:
      providerOptions.anthropic?.thinking ??
      (adaptiveThinking ? { type: 'adaptive' } : { type: 'enabled', budgetTokens: budget }),
    ...(adaptiveThinking
      ? {
          effort:
            providerOptions.anthropic?.effort ??
            (request.reasoning?.effort === 'minimal' ? 'low' : request.reasoning?.effort),
        }
      : {}),
  };
  return providerOptions;
}

// ---------- Per-message effort ----------
// Beta `mid-conversation-output-config-2026-07-01`: an effort-only message
// `{"role":"system","content":[],"output_config":{"effort":...}}` changes effort for later
// turns while the top-level `output_config.effort` stays put, so the cached prefix survives
// (measured on Claude Haiku 5.5, 2026-11-14; model/effort-updates.ts). The AI SDK cannot
// express that message, so an `effort_update` marker becomes a sentinel text part at the
// start of the user message it governs, and the fetch wrapper replaces the sentinel with
// the effort message placed just before that user message, adding the beta header. A body
// without the sentinel is forwarded untouched, byte for byte.

/** Markers as sentinels on the next user message; with no later user message a marker has no turn to govern. */
function withEffortSentinels(request: StreamedModelTurnRequest): StreamedModelTurnRequest {
  if (!request.input.some((item) => item.type === 'effort_update')) return request;
  const input: StreamedModelTurnInput[] = [];
  let pending: string | undefined;
  for (const item of request.input) {
    if (item.type === 'effort_update') pending = item.effort;
    else if (pending !== undefined && item.type === 'message' && item.role === 'user') {
      input.push({ ...item, content: [{ type: 'text', text: effortSentinel(pending) }, ...item.content] });
      pending = undefined;
    } else input.push(item);
  }
  return { ...request, input };
}

const ANTHROPIC_EFFORT_BETA = 'mid-conversation-output-config-2026-07-01';

const SENTINEL_PREFIX = 'term2-effort-update:9c4e1f7a:';
const SENTINEL = /^term2-effort-update:9c4e1f7a:([a-z]+)$/;

function effortSentinel(effort: string): string {
  return `${SENTINEL_PREFIX}${effort}`;
}

function withAnthropicEffortMessages(base: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = init?.body;
    if (typeof body !== 'string' || !body.includes(SENTINEL_PREFIX)) return base(input, init);
    let parsed: { messages?: unknown; output_config?: Record<string, unknown> };
    try {
      parsed = JSON.parse(body);
    } catch {
      return base(input, init);
    }
    const placed = placeEffortMessages(parsed);
    if (placed) return base(input, { ...init, body: placed, headers: withEffortBeta(init?.headers) });
    // Never fail a turn over a marker: send today's request, the effective effort top-level.
    return base(input, { ...init, body: JSON.stringify(withTopLevelEffort(parsed)) });
  }) as typeof fetch;
}

const sentinelEffort = (part: any): string | undefined =>
  part?.type === 'text' && typeof part.text === 'string' ? SENTINEL.exec(part.text)?.[1] : undefined;

/**
 * Each sentinel becomes an effort-only message where it stood. The AI SDK merges consecutive
 * user messages (a turn that got no answer is followed directly by the next one), so a
 * sentinel can sit anywhere in a user message; the message is split around it. Undefined when
 * a sentinel cannot be placed exactly.
 */
function placeEffortMessages(parsed: { messages?: unknown }): string | undefined {
  if (!Array.isArray(parsed.messages)) return undefined;
  const messages: unknown[] = [];
  for (const message of parsed.messages as any[]) {
    if (message?.role !== 'user' || !Array.isArray(message.content)) {
      messages.push(message);
      continue;
    }
    let segment: unknown[] = [];
    for (const part of message.content) {
      const effort = sentinelEffort(part);
      if (effort === undefined) {
        segment.push(part);
        continue;
      }
      if (part.cache_control !== undefined) return undefined;
      if (segment.length) messages.push({ ...message, content: segment });
      messages.push({ role: 'system', content: [], output_config: { effort } });
      segment = [];
    }
    if (segment.length) messages.push({ ...message, content: segment });
  }
  const rewritten = JSON.stringify({ ...parsed, messages });
  return rewritten.includes(SENTINEL_PREFIX) ? undefined : rewritten;
}

function withTopLevelEffort(parsed: { messages?: unknown; output_config?: Record<string, unknown> }) {
  let effort: string | undefined;
  const messages = Array.isArray(parsed.messages)
    ? (parsed.messages as any[]).flatMap((message) => {
        if (!Array.isArray(message?.content)) return [message];
        const content = message.content.filter((part: unknown) => {
          const found = sentinelEffort(part);
          if (found !== undefined) effort = found;
          return found === undefined;
        });
        return content.length ? [{ ...message, content }] : [];
      })
    : parsed.messages;
  return {
    ...parsed,
    messages,
    ...(effort !== undefined ? { output_config: { ...parsed.output_config, effort } } : {}),
  };
}

function withEffortBeta(source: HeadersInit | undefined): Headers {
  const headers = new Headers(source);
  const betas = (headers.get('anthropic-beta') ?? '')
    .split(',')
    .map((beta) => beta.trim())
    .filter(Boolean);
  if (!betas.includes(ANTHROPIC_EFFORT_BETA))
    headers.set('anthropic-beta', [...betas, ANTHROPIC_EFFORT_BETA].join(','));
  return headers;
}
