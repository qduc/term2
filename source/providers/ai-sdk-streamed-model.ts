import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ToolChoice,
  LanguageModelV3ToolResultOutput,
  SharedV3ProviderOptions,
  JSONSchema7,
} from '@ai-sdk/provider';
import { withMergedAssistantMessages } from './ai-sdk-message-normalizer.js';
import type {
  StreamedModelMessagePart,
  StreamedModelToolResultPart,
  StreamedModelTurn,
  StreamedModelTurnInput,
  StreamedModelTurnRequest,
  StreamedModelTurnEvent,
  StreamedModelTurnOutput,
} from '../contracts/streamed-model-turn.js';

const MAX_TRIVIAL_WHITESPACE_LENGTH = 4;

function isTrivialWhitespace(text: string): boolean {
  return text.length > 0 && text.length <= MAX_TRIVIAL_WHITESPACE_LENGTH && text.trim() === '';
}

type UnaryGenerateResult = Awaited<ReturnType<LanguageModelV3['doGenerate']>> & {
  /** Guarded vendor text, reasoning, and tool-call extensions for unary results. */
  text?: string;
  reasoning?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; input?: string }>;
};

/** Adapts one AI SDK LanguageModelV3 stream to the application-owned turn protocol. */
export function createAiSdkStreamedModel(
  model: LanguageModelV3,
  providerFamily: 'anthropic' | 'google' | undefined = undefined,
): StreamedModelTurn {
  const normalizedModel = withMergedAssistantMessages(model);
  const reasoningProvider = providerFamily ?? model.provider;
  return {
    async getResponse(request: StreamedModelTurnRequest) {
      const result = (await normalizedModel.doGenerate(
        toCallOptions(request, reasoningProvider),
      )) as UnaryGenerateResult;
      const output: StreamedModelTurnOutput[] = [];
      if (typeof result.reasoning === 'string' && result.reasoning) {
        output.push({ type: 'reasoning', text: result.reasoning });
      }
      if (typeof result.text === 'string' && result.text) {
        output.push({ type: 'message', content: [{ type: 'text', text: result.text }] });
      }
      for (const call of result.toolCalls ?? []) {
        output.push({ type: 'tool_call', id: call.toolCallId, name: call.toolName, arguments: call.input ?? '{}' });
      }
      const usage = result.usage ?? {};
      const costUsd = extractAiSdkCostUsd(result.providerMetadata, usage);
      return {
        responseId: result.response?.id ?? `response-${Date.now()}`,
        output,
        usage: {
          ...(usage.inputTokens?.total !== undefined ? { inputTokens: usage.inputTokens.total } : {}),
          ...(usage.outputTokens?.total !== undefined ? { outputTokens: usage.outputTokens.total } : {}),
          ...(usage.inputTokens?.cacheRead !== undefined ? { cachedInputTokens: usage.inputTokens.cacheRead } : {}),
          ...(usage.inputTokens?.cacheWrite !== undefined ? { cacheWriteTokens: usage.inputTokens.cacheWrite } : {}),
        },
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(result.providerMetadata ? { providerMetadata: result.providerMetadata } : {}),
      };
    },
    async *stream(request) {
      const result = await normalizedModel.doStream(toCallOptions(request, reasoningProvider));
      let responseId: string | undefined;
      let completionMetadata: Record<string, unknown> | undefined;
      const output: StreamedModelTurnOutput[] = [];
      const reasoning = new Map<string, { text: string; providerMetadata?: Record<string, unknown> }>();
      const toolCalls = new Map<string, { name: string; argumentCharCount: number }>();
      let pendingTrivialWhitespace = '';
      let hasMaterialOutput = false;
      // Providers can emit a one-character placeholder immediately before an
      // in-band error. Keep only a bounded leading prefix uncommitted so the
      // RetryingModel's any-yield-is-committed invariant remains unchanged.
      const flushPendingWhitespace = (): StreamedModelTurnEvent | undefined => {
        if (!pendingTrivialWhitespace) return undefined;
        const text = pendingTrivialWhitespace;
        pendingTrivialWhitespace = '';
        appendText(output, text);
        hasMaterialOutput = true;
        return { type: 'text_delta', text };
      };

      for await (const part of result.stream) {
        if (part.type === 'response-metadata') {
          if (part.id !== undefined) responseId = part.id;
          continue;
        }
        if (part.type === 'text-delta') {
          // Empty text frames are not material. In particular, do not let one
          // between a placeholder and an error force the placeholder out.
          if (!part.delta && pendingTrivialWhitespace) continue;
          if (
            !hasMaterialOutput &&
            isTrivialWhitespace(part.delta) &&
            pendingTrivialWhitespace.length + part.delta.length <= MAX_TRIVIAL_WHITESPACE_LENGTH
          ) {
            pendingTrivialWhitespace += part.delta;
            continue;
          }
          const flushedWhitespace = flushPendingWhitespace();
          if (flushedWhitespace) yield flushedWhitespace;
          appendText(output, part.delta);
          if (part.delta) hasMaterialOutput = true;
          yield { type: 'text_delta', text: part.delta };
          continue;
        }
        if (part.type === 'reasoning-start') {
          const current = { text: '', ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}) };
          reasoning.set(part.id, current);
          output.push({
            type: 'reasoning',
            id: part.id,
            text: current.text,
            ...(current.providerMetadata ? { providerMetadata: current.providerMetadata } : {}),
          });
          continue;
        }
        if (part.type === 'reasoning-delta') {
          const flushedWhitespace = flushPendingWhitespace();
          if (flushedWhitespace) yield flushedWhitespace;
          const current = reasoning.get(part.id) ?? { text: '' };
          current.text += part.delta;
          if (part.providerMetadata) current.providerMetadata = part.providerMetadata;
          reasoning.set(part.id, current);
          const outputReasoning = output.find((item) => item.type === 'reasoning' && item.id === part.id);
          if (outputReasoning?.type === 'reasoning') {
            (outputReasoning as { text: string; providerMetadata?: Record<string, unknown> }).text = current.text;
            if (current.providerMetadata)
              (outputReasoning as { providerMetadata?: Record<string, unknown> }).providerMetadata =
                current.providerMetadata;
          }
          yield {
            type: 'reasoning_delta',
            id: part.id,
            text: part.delta,
            ...(current.providerMetadata ? { providerMetadata: current.providerMetadata } : {}),
          };
          hasMaterialOutput = true;
          continue;
        }
        if (part.type === 'reasoning-end') {
          const current = reasoning.get(part.id);
          if (current && part.providerMetadata) {
            current.providerMetadata = part.providerMetadata;
            const outputIndex = output.findIndex((item) => item.type === 'reasoning' && item.id === part.id);
            const outputReasoning = output.at(outputIndex);
            if (outputReasoning?.type === 'reasoning')
              output[outputIndex] = { ...outputReasoning, providerMetadata: part.providerMetadata };
          }
          continue;
        }
        if (part.type === 'tool-input-start') {
          toolCalls.set(part.id, { name: part.toolName, argumentCharCount: 0 });
          continue;
        }
        if (part.type === 'tool-input-delta') {
          const flushedWhitespace = flushPendingWhitespace();
          if (flushedWhitespace) yield flushedWhitespace;
          const current = toolCalls.get(part.id) ?? { name: '', argumentCharCount: 0 };
          current.argumentCharCount += part.delta.length;
          toolCalls.set(part.id, current);
          yield {
            type: 'tool_call_streaming_delta',
            ...(current.name ? { toolName: current.name } : {}),
            argumentCharCount: current.argumentCharCount,
          };
          hasMaterialOutput = true;
          continue;
        }
        if (
          part.type === 'tool-input-end' ||
          part.type === 'text-start' ||
          part.type === 'text-end' ||
          part.type === 'stream-start' ||
          part.type === 'raw' ||
          part.type === 'file' ||
          part.type === 'source' ||
          part.type === 'tool-result' ||
          part.type === 'tool-approval-request'
        ) {
          continue;
        }
        if (part.type === 'tool-call') {
          const flushedWhitespace = flushPendingWhitespace();
          if (flushedWhitespace) yield flushedWhitespace;
          yield* publishToolCall(output, part.toolCallId, { name: part.toolName, arguments: part.input });
          hasMaterialOutput = true;
          continue;
        }
        if (part.type === 'finish') {
          if (part.finishReason.unified === 'other' && part.finishReason.raw == null) {
            throw new Error('AI SDK streamed response ended without an authoritative native finish reason');
          }
          completionMetadata = part.providerMetadata;
          const id = responseId;
          if (!id) throw new Error('AI SDK streamed response did not include a response id');
          const flushedWhitespace = flushPendingWhitespace();
          if (flushedWhitespace) yield flushedWhitespace;
          appendUnendedReasoning(output, reasoning);
          const costUsd = extractAiSdkCostUsd(part.providerMetadata, part.usage);
          yield {
            type: 'completion',
            responseId: id,
            output,
            finishReason: part.finishReason.unified,
            usage: {
              ...(part.usage.inputTokens.total !== undefined ? { inputTokens: part.usage.inputTokens.total } : {}),
              ...(part.usage.outputTokens.total !== undefined ? { outputTokens: part.usage.outputTokens.total } : {}),
              ...(part.usage.inputTokens.cacheRead !== undefined
                ? { cachedInputTokens: part.usage.inputTokens.cacheRead }
                : {}),
              ...(part.usage.inputTokens.cacheWrite !== undefined
                ? { cacheWriteTokens: part.usage.inputTokens.cacheWrite }
                : {}),
            },
            ...(costUsd !== undefined ? { costUsd } : {}),
            providerMetadata: { ...completionMetadata, model: `${model.provider}:${model.modelId}`, responseId: id },
          };
          return;
        }
        if (part.type === 'error') {
          pendingTrivialWhitespace = '';
          throw part.error;
        }
      }
      pendingTrivialWhitespace = '';
      throw new Error('AI SDK streamed response ended without a finish event');
    },
  };
}

type CallOptionsWithReasoning = LanguageModelV3CallOptions;

const reasoningBudgets = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
} as const;

function reasoningProviderOptions(
  request: StreamedModelTurnRequest,
  provider: string,
): SharedV3ProviderOptions | undefined {
  const effort = request.reasoning?.effort;
  const budget =
    effort && effort !== 'none' && effort !== 'default'
      ? reasoningBudgets[effort as keyof typeof reasoningBudgets]
      : undefined;
  if (budget === undefined) return request.providerOptions as SharedV3ProviderOptions | undefined;

  const providerOptions: SharedV3ProviderOptions = {
    ...(request.providerOptions as SharedV3ProviderOptions | undefined),
  };
  if (provider.startsWith('anthropic')) {
    providerOptions.anthropic = {
      ...(providerOptions.anthropic ?? {}),
      thinking: providerOptions.anthropic?.thinking ?? { type: 'enabled', budgetTokens: budget },
    };
  } else if (provider.startsWith('google')) {
    providerOptions.google = {
      ...(providerOptions.google ?? {}),
      thinkingConfig: providerOptions.google?.thinkingConfig ?? { thinkingBudget: budget, includeThoughts: true },
    };
  }
  return providerOptions;
}

function toCallOptions(request: StreamedModelTurnRequest, provider: string): CallOptionsWithReasoning {
  const toolNames = new Map(
    request.input.filter((item) => item.type === 'tool_call').map((item) => [item.id, item.name]),
  );
  const instructions: LanguageModelV3Prompt = request.instructions
    ? [{ role: 'system', content: request.instructions }]
    : [];
  return {
    prompt: [
      ...instructions,
      // The AI SDK lane never produces opaque items, so any it sees came from
      // another provider and is inert baggage left by a switch, not a fault.
      // See `provider-opaque-compatibility.ts`.
      ...request.input
        .filter((item) => item.type !== 'provider_opaque')
        .map((item) => toPromptMessage(item, toolNames)),
    ],
    ...(request.tools.length ? { tools: request.tools.map(toTool) } : {}),
    ...(request.toolChoice ? { toolChoice: toToolChoice(request.toolChoice) } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { topP: request.topP } : {}),
    ...(request.frequencyPenalty !== undefined ? { frequencyPenalty: request.frequencyPenalty } : {}),
    ...(request.presencePenalty !== undefined ? { presencePenalty: request.presencePenalty } : {}),
    ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
    ...(request.outputType && request.outputType !== 'text'
      ? {
          responseFormat: {
            type: 'json' as const,
            name: request.outputType.name,
            schema: request.outputType.schema as JSONSchema7,
          },
        }
      : {}),
    ...(reasoningProviderOptions(request, provider)
      ? { providerOptions: reasoningProviderOptions(request, provider) }
      : {}),
    ...(request.signal ? { abortSignal: request.signal } : {}),
  };
}

function toPromptMessage(item: StreamedModelTurnInput, toolNames: Map<string, string>): LanguageModelV3Message {
  if (item.type === 'message') {
    if (item.role === 'system') return { role: 'system', content: item.content.map((part) => part.text).join('') };
    return { role: item.role, content: item.content.map(toMessagePart) };
  }
  if (item.type === 'reasoning')
    return {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: item.text,
          ...(item.providerMetadata ? { providerOptions: item.providerMetadata as SharedV3ProviderOptions } : {}),
        },
      ],
    };
  if (item.type === 'tool_call')
    return {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: item.id, toolName: item.name, input: parseJson(item.arguments) }],
    };
  if (item.type === 'provider_opaque')
    // Filtered out in `toCallOptions`; reaching here means a new caller bypassed
    // that filter, which would put a foreign payload on the wire.
    throw new Error(
      `Refusing to serialize provider_opaque from '${item.provider}' through the AI SDK: opaque items are only valid on the provider that produced them`,
    );
  const toolName = toolNames.get(item.id);
  if (!toolName) throw new Error(`AI SDK tool result has no matching tool call: ${item.id}`);
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: item.id, toolName, output: toToolResult(item.output) }],
  };
}

function toMessagePart(part: StreamedModelMessagePart): { type: 'text'; text: string } | LanguageModelV3FilePart {
  if (part.type === 'text') return part;
  if (!part.image) throw new Error('AI SDK image message part requires an image');
  const data = typeof part.image === 'object' ? part.image.id : part.image;
  return {
    type: 'file',
    data,
    mediaType: mediaType(data),
    ...(part.detail ? { providerOptions: { detail: { detail: part.detail } } } : {}),
  };
}

function toToolResult(output: string | readonly StreamedModelToolResultPart[]): LanguageModelV3ToolResultOutput {
  if (typeof output === 'string') return { type: 'text', value: output };
  return { type: 'content', value: output.map(toToolResultPart) };
}

function toToolResultPart(
  part: StreamedModelToolResultPart,
): Extract<LanguageModelV3ToolResultOutput, { type: 'content' }>['value'][number] {
  if (part.type === 'text') return part;
  const value = part.type === 'image' ? part.image : part.file;
  if (!value) throw new Error('AI SDK tool result part requires file or image data');
  if (typeof value === 'string')
    return part.type === 'image' ? { type: 'image-url', url: value } : { type: 'file-url', url: value };
  if ('data' in value)
    return {
      type: part.type === 'image' ? 'image-data' : 'file-data',
      data: typeof value.data === 'string' ? value.data : Buffer.from(value.data).toString('base64'),
      mediaType: value.mediaType ?? 'application/octet-stream',
    };
  if ('url' in value)
    return part.type === 'image' ? { type: 'image-url', url: value.url } : { type: 'file-url', url: value.url };
  return {
    type: part.type === 'image' ? 'image-file-id' : 'file-id',
    fileId: 'fileId' in value ? value.fileId : value.id,
  };
}

function toTool(tool: StreamedModelTurnRequest['tools'][number]): LanguageModelV3FunctionTool {
  if (tool.type === 'custom') {
    throw new Error(`AI SDK transport does not support custom tool '${tool.name}'.`);
  }
  return {
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.parameters as LanguageModelV3FunctionTool['inputSchema'],
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
  };
}

function toToolChoice(choice: NonNullable<StreamedModelTurnRequest['toolChoice']>): LanguageModelV3ToolChoice {
  return typeof choice === 'object' ? { type: 'tool', toolName: choice.name } : { type: choice };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mediaType(value: string): string {
  return value.match(/^data:([^;,]+)/)?.[1] ?? 'image/*';
}

function appendText(output: StreamedModelTurnOutput[], text: string) {
  const last = output.at(-1);
  if (last?.type === 'message') {
    const part = last.content.at(-1);
    if (part) (part as { text: string }).text += text;
    return;
  }
  output.push({ type: 'message', content: [{ type: 'text', text }] });
}

function appendUnendedReasoning(
  output: StreamedModelTurnOutput[],
  reasoning: Map<string, { text: string; providerMetadata?: Record<string, unknown> }>,
) {
  for (const [id, current] of reasoning) {
    if (output.some((item) => item.type === 'reasoning' && item.id === id)) continue;
    output.push({
      type: 'reasoning',
      id,
      text: current.text,
      ...(current.providerMetadata ? { providerMetadata: current.providerMetadata } : {}),
    });
  }
}

function* publishToolCall(output: StreamedModelTurnOutput[], id: string, call: { name: string; arguments: string }) {
  const event = { type: 'tool_call' as const, id, name: call.name, arguments: call.arguments };
  output.push(event);
  yield event;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseCostValue(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return undefined;
}

/**
 * Extract provider-reported cost (USD amount or credits) from AI SDK
 * provider metadata or usage when present (e.g. OpenRouter usage accounting).
 */
export function extractAiSdkCostUsd(
  providerMetadata?: Record<string, unknown>,
  usage?: unknown,
): number | string | undefined {
  const usageRecord = asRecord(usage);
  if (usageRecord) {
    const rawRecord = asRecord(usageRecord.raw);
    const rawCost = parseCostValue(rawRecord?.cost ?? usageRecord.cost);
    if (rawCost !== undefined) return rawCost;
  }

  if (!providerMetadata || typeof providerMetadata !== 'object') return undefined;

  const openrouter = asRecord(providerMetadata.openrouter);
  if (openrouter) {
    const openrouterUsage = asRecord(openrouter.usage);
    const costDetails = asRecord(openrouterUsage?.costDetails) ?? asRecord(openrouterUsage?.cost_details);
    const cost = parseCostValue(
      openrouterUsage?.cost ??
        openrouter.cost ??
        costDetails?.upstreamInferenceCost ??
        costDetails?.upstream_inference_cost,
    );
    if (cost !== undefined) return cost;
  }

  for (const [key, value] of Object.entries(providerMetadata)) {
    if (key === 'model' || key === 'responseId') continue;
    const record = asRecord(value);
    if (record) {
      const nestedUsage = asRecord(record.usage);
      const costDetails = asRecord(nestedUsage?.costDetails) ?? asRecord(nestedUsage?.cost_details);
      const nestedCost = parseCostValue(
        nestedUsage?.cost ?? record.cost ?? costDetails?.upstreamInferenceCost ?? costDetails?.upstream_inference_cost,
      );
      if (nestedCost !== undefined) return nestedCost;
    }
  }

  return undefined;
}

/**
 * Extract provider-reported upstream provider name (e.g. OpenRouter upstream routing)
 * from AI SDK provider metadata when present.
 */
export function extractAiSdkUpstreamProvider(providerMetadata?: Record<string, unknown>): string | undefined {
  if (!providerMetadata || typeof providerMetadata !== 'object') return undefined;

  const openrouter = asRecord(providerMetadata.openrouter);
  if (openrouter) {
    if (typeof openrouter.provider === 'string' && openrouter.provider.trim().length > 0) {
      return openrouter.provider.trim();
    }
    if (typeof openrouter.provider_name === 'string' && openrouter.provider_name.trim().length > 0) {
      return openrouter.provider_name.trim();
    }
  }

  if (typeof providerMetadata.provider === 'string' && providerMetadata.provider.trim().length > 0) {
    return providerMetadata.provider.trim();
  }
  if (typeof providerMetadata.provider_name === 'string' && providerMetadata.provider_name.trim().length > 0) {
    return providerMetadata.provider_name.trim();
  }

  for (const [key, value] of Object.entries(providerMetadata)) {
    if (key === 'model' || key === 'responseId') continue;
    const record = asRecord(value);
    if (record) {
      if (typeof record.provider === 'string' && record.provider.trim().length > 0) {
        return record.provider.trim();
      }
      if (typeof record.provider_name === 'string' && record.provider_name.trim().length > 0) {
        return record.provider_name.trim();
      }
    }
  }

  return undefined;
}
