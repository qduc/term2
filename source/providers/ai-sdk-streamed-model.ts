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
} from '@ai-sdk/provider';
import { withMergedAssistantMessages } from './ai-sdk-message-normalizer.js';
import type {
  StreamedModelMessagePart,
  StreamedModelToolResultPart,
  StreamedModelTurn,
  StreamedModelTurnInput,
  StreamedModelTurnRequest,
  StreamedModelTurnOutput,
} from '../contracts/streamed-model-turn.js';

/** Adapts one AI SDK LanguageModelV3 stream to the application-owned turn protocol. */
export function createAiSdkStreamedModel(model: LanguageModelV3): StreamedModelTurn {
  const normalizedModel = withMergedAssistantMessages(model);
  return {
    async *stream(request) {
      const result = await normalizedModel.doStream(toCallOptions(request));
      let responseId: string | undefined;
      let completionMetadata: Record<string, unknown> | undefined;
      const output: StreamedModelTurnOutput[] = [];
      const reasoning = new Map<string, { text: string; providerMetadata?: Record<string, unknown> }>();

      for await (const part of result.stream) {
        if (part.type === 'response-metadata') {
          if (part.id !== undefined) responseId = part.id;
          continue;
        }
        if (part.type === 'text-delta') {
          appendText(output, part.delta);
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
        if (
          part.type === 'tool-input-start' ||
          part.type === 'tool-input-delta' ||
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
          yield* publishToolCall(output, part.toolCallId, { name: part.toolName, arguments: part.input });
          continue;
        }
        if (part.type === 'finish') {
          completionMetadata = part.providerMetadata;
          const id = responseId;
          if (!id) throw new Error('AI SDK streamed response did not include a response id');
          appendUnendedReasoning(output, reasoning);
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
            providerMetadata: { ...completionMetadata, model: `${model.provider}:${model.modelId}`, responseId: id },
          };
          return;
        }
        if (part.type === 'error') throw part.error;
      }
      throw new Error('AI SDK streamed response ended without a finish event');
    },
  };
}

type CallOptionsWithReasoning = LanguageModelV3CallOptions & {
  /** Characterized provider behavior; V3 does not yet expose a reasoning call option. */
  reasoning?: StreamedModelTurnRequest['reasoning'];
};

function toCallOptions(request: StreamedModelTurnRequest): CallOptionsWithReasoning {
  const toolNames = new Map(
    request.input.filter((item) => item.type === 'tool_call').map((item) => [item.id, item.name]),
  );
  const instructions: LanguageModelV3Prompt = request.instructions
    ? [{ role: 'system', content: request.instructions }]
    : [];
  return {
    prompt: [...instructions, ...request.input.map((item) => toPromptMessage(item, toolNames))],
    ...(request.tools.length ? { tools: request.tools.map(toTool) } : {}),
    ...(request.toolChoice ? { toolChoice: toToolChoice(request.toolChoice) } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { topP: request.topP } : {}),
    ...(request.frequencyPenalty !== undefined ? { frequencyPenalty: request.frequencyPenalty } : {}),
    ...(request.presencePenalty !== undefined ? { presencePenalty: request.presencePenalty } : {}),
    ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
    ...(request.reasoning ? { reasoning: request.reasoning } : {}),
    ...(request.providerOptions ? { providerOptions: request.providerOptions as SharedV3ProviderOptions } : {}),
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
