import { assertValidOpenAICompatibleMessages } from './common/openai-compatible-message-contract.js';
import type { CostTrailerCapture } from './openai-compatible-response-normalizer.js';
import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
  StreamedModelUsage,
} from '../contracts/streamed-model-turn.js';

/** Application-owned adapter for OpenAI-compatible chat-completions endpoints. */
export class OpenAIChatCompletionsModel implements StreamedModelTurn {
  private readonly client: any;
  private readonly model: string;
  private readonly costCapture?: CostTrailerCapture;

  constructor(client: any, model: string, costCapture?: CostTrailerCapture) {
    this.client = client;
    this.model = model.trim();
    this.costCapture = costCapture;
  }

  // createCustomProviderModelProvider() (openai-compatible.provider.ts) returns
  // this class for the 'openai'/'openai-compatible'/'llama.cpp' provider types,
  // and every caller requires a `getStreamedModel()` method — the class already
  // implements StreamedModelTurn directly via `stream()`, so it just returns itself.
  getStreamedModel(): this {
    return this;
  }

  async *stream(request: StreamedModelTurnRequest): AsyncIterable<StreamedModelTurnEvent> {
    const messages = [
      ...(request.instructions ? [{ role: 'system', content: request.instructions }] : []),
      ...openAICompatibleMessages(request.input),
    ];
    assertValidOpenAICompatibleMessages(messages);
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: tool })) } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.frequencyPenalty !== undefined ? { frequency_penalty: request.frequencyPenalty } : {}),
      ...(request.presencePenalty !== undefined ? { presence_penalty: request.presencePenalty } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.toolChoice !== undefined ? { tool_choice: toChatToolChoice(request.toolChoice) } : {}),
      ...(request.reasoning?.effort ? { reasoning_effort: request.reasoning.effort } : {}),
      ...(request.providerOptions ?? {}),
      ...(request.outputType && request.outputType !== 'text'
        ? { response_format: toChatResponseFormat(request.outputType) }
        : {}),
      signal: request.signal,
    });
    // Keyed by the tool call's stream `index`, which every provider sends on
    // every chunk. `id` (and often `name`) only arrives on the first chunk for
    // that index; later chunks carry just `{ index, function: { arguments } }`
    // with no `id`. Keying by `id ?? index` used to split one tool call into
    // two accumulator entries once the id-less chunks fell back to the index key.
    const calls = new Map<number, { id?: string; name: string; arguments: string }>();
    let text = '';
    let reasoning = '';
    let sawFinishReason = false;
    let finishReason: string | undefined;
    let usage: StreamedModelUsage | undefined;
    for await (const chunk of response) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (choice?.finish_reason != null) {
        sawFinishReason = true;
        finishReason = choice.finish_reason;
      }
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content;
        yield {
          type: 'reasoning_delta',
          text: delta.reasoning_content,
          providerMetadata: {
            reasoning_content: delta.reasoning_content,
            openai_compatible_reasoning_content: true,
          },
        };
      }
      if (delta?.content) {
        text += delta.content;
        yield { type: 'text_delta', text: delta.content };
      }
      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = calls.get(index) ?? { name: '', arguments: '' };
        if (call.id) current.id = call.id;
        current.name += call.function?.name ?? '';
        const argumentDelta = call.function?.arguments ?? '';
        current.arguments += argumentDelta;
        calls.set(index, current);
        if (argumentDelta) {
          yield {
            type: 'tool_call_streaming_delta',
            ...(current.name ? { toolName: current.name } : {}),
            argumentCharCount: current.arguments.length,
          };
        }
      }
      if (chunk.usage) {
        // Chat providers place usage on the terminal chunk rather than a
        // delta. Retain the latest frame for the application completion;
        // providers may omit it entirely.
        usage = normalizeChatUsage(chunk.usage) as typeof usage;
      }
    }
    if (!sawFinishReason) throw new Error('OpenAI-compatible streamed response ended without a finish reason');
    for (const [index, call] of calls)
      yield { type: 'tool_call', id: call.id ?? `call_${index}`, name: call.name, arguments: call.arguments };
    yield {
      type: 'completion',
      responseId: `chatcmpl-${Date.now()}`,
      ...(finishReason !== undefined ? { finishReason } : {}),
      usage,
      // The normalized reasoning stream captures the cost-only trailer into the
      // shared capture object; surface it as the provider-reported charge.
      ...(this.costCapture?.cost !== undefined ? { costUsd: this.costCapture.cost } : {}),
      output: [
        ...(reasoning
          ? [
              {
                type: 'reasoning' as const,
                text: reasoning,
                providerMetadata: { reasoning_content: reasoning, openai_compatible_reasoning_content: true },
              },
            ]
          : []),
        ...(calls.size
          ? [...calls].map(([index, call]) => ({
              type: 'tool_call' as const,
              id: call.id ?? `call_${index}`,
              name: call.name,
              arguments: call.arguments,
            }))
          : [{ type: 'message' as const, content: [{ type: 'text' as const, text }] }]),
      ],
    };
  }
}

function toChatResponseFormat(outputType: Exclude<NonNullable<StreamedModelTurnRequest['outputType']>, 'text'>): any {
  return {
    type: 'json_schema',
    json_schema: {
      name: outputType.name,
      strict: outputType.strict,
      schema: outputType.schema,
    },
  };
}

function toChatToolChoice(choice: NonNullable<StreamedModelTurnRequest['toolChoice']>): any {
  if (typeof choice === 'object') return { type: 'function', function: { name: choice.name } };
  return choice;
}

function normalizeChatUsage(usage: any): StreamedModelUsage {
  const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.inputTokens;
  const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? usage?.outputTokens;
  const details = usage?.prompt_tokens_details ?? usage?.input_tokens_details ?? usage?.inputTokensDetails;
  const cachedInputTokens =
    usage?.cached_tokens ?? usage?.cachedTokens ?? details?.cached_tokens ?? details?.cachedTokens;
  const cacheWriteTokens =
    usage?.cache_write_tokens ??
    usage?.cacheWriteTokens ??
    usage?.cache_creation_input_tokens ??
    usage?.cache_creation_tokens ??
    details?.cache_write_tokens ??
    details?.cacheWriteTokens;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

function openAICompatibleMessages(input: StreamedModelTurnRequest['input']): any[] {
  const messages: any[] = [];
  let pendingReasoningContent = '';

  for (const item of input) {
    if (item.type === 'reasoning') {
      const directNativeReasoning = item.providerMetadata?.reasoning_content;
      // Persistence intentionally removes the duplicate text field from a
      // standalone reasoning item. Keep this marker so restored native
      // OpenAI-compatible reasoning is still distinguished from generic
      // provider reasoning without sending a foreign field to other models.
      const nativeReasoning =
        typeof directNativeReasoning === 'string'
          ? directNativeReasoning
          : item.providerMetadata?.openai_compatible_reasoning_content === true
          ? item.text
          : undefined;
      if (typeof nativeReasoning === 'string') {
        pendingReasoningContent += nativeReasoning;
      } else {
        // Generic reasoning has no Chat Completions wire representation.
        // Retain the historical assistant-text fallback without inventing a
        // provider-native `reasoning_content` field for unrelated providers.
        messages.push({ role: 'assistant', content: item.text });
      }
      continue;
    }
    if (item.type === 'message') {
      const content = item.content.map((part: any) => {
        if (part.type === 'image') {
          const image = part.image;
          const url = typeof image === 'string' ? image : image?.id;
          return { type: 'image_url', image_url: { url } };
        }
        return { type: 'text', text: part.text };
      });
      messages.push({
        role: item.role,
        content,
        ...(item.role === 'assistant' && pendingReasoningContent ? { reasoning_content: pendingReasoningContent } : {}),
      });
      if (item.role === 'assistant') pendingReasoningContent = '';
      continue;
    }
    if (item.type === 'tool_call') {
      const toolCall = { id: item.id, type: 'function', function: { name: item.name, arguments: item.arguments } };
      const previous = messages[messages.length - 1];
      if (previous?.role === 'assistant' && Array.isArray(previous.tool_calls)) {
        previous.tool_calls.push(toolCall);
      } else {
        messages.push({
          role: 'assistant',
          ...(pendingReasoningContent ? { content: null, reasoning_content: pendingReasoningContent } : {}),
          tool_calls: [toolCall],
        });
      }
      pendingReasoningContent = '';
      continue;
    }
    if (item.type === 'tool_result') {
      messages.push({
        role: 'tool',
        tool_call_id: item.id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
      });
    }
  }

  // Chat Completions requires assistant messages to contain content or tool
  // calls. Native reasoning is continuation metadata for the matching
  // assistant message/tool call, not a valid standalone message; if no such
  // item follows, omit it rather than creating a provider-invalid request.
  return coalesceReasoningToolCallBatches(messages);
}

function coalesceReasoningToolCallBatches(messages: any[]): any[] {
  const result: any[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !message.reasoning_content || !Array.isArray(message.tool_calls)) {
      result.push(message);
      continue;
    }

    const toolResults: any[] = [];
    while (index + 1 < messages.length) {
      const next = messages[index + 1];
      if (next?.role === 'tool') {
        toolResults.push(next);
        index += 1;
        continue;
      }
      if (
        next?.role === 'assistant' &&
        Array.isArray(next.tool_calls) &&
        next.reasoning_content == null &&
        next.content == null
      ) {
        message.tool_calls.push(...next.tool_calls);
        index += 1;
        continue;
      }
      break;
    }
    result.push(message, ...toolResults);
  }
  return result;
}
