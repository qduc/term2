import type { LanguageModelV3 } from '@ai-sdk/provider';
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
      const toolInputs = new Map<string, { name: string; arguments: string }>();

      for await (const part of result.stream as any) {
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
          continue;
        }
        if (part.type === 'tool-input-start') {
          toolInputs.set(part.id, { name: part.toolName, arguments: '' });
          continue;
        }
        if (part.type === 'tool-input-delta') {
          const current = toolInputs.get(part.id);
          if (current) current.arguments += part.delta;
          continue;
        }
        if (part.type === 'tool-input-end') {
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

function toCallOptions(request: StreamedModelTurnRequest): any {
  const toolNames = new Map(
    request.input.filter((item) => item.type === 'tool_call').map((item) => [item.id, item.name]),
  );
  return {
    prompt: [
      ...(request.instructions ? [{ role: 'system', content: request.instructions }] : []),
      ...request.input.map((item) => toPromptMessage(item, toolNames)),
    ],
    ...(request.tools.length ? { tools: request.tools.map(toTool) } : {}),
    ...(request.toolChoice ? { toolChoice: toToolChoice(request.toolChoice) } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { topP: request.topP } : {}),
    ...(request.frequencyPenalty !== undefined ? { frequencyPenalty: request.frequencyPenalty } : {}),
    ...(request.presencePenalty !== undefined ? { presencePenalty: request.presencePenalty } : {}),
    ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
    ...(request.reasoning ? { reasoning: request.reasoning } : {}),
    ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
    ...(request.signal ? { abortSignal: request.signal } : {}),
  };
}

function toPromptMessage(item: StreamedModelTurnInput, toolNames: Map<string, string>): any {
  if (item.type === 'message') {
    if (item.role === 'system') return { role: 'system', content: item.content.map(messageText).join('') };
    return { role: item.role, content: item.content.map(toMessagePart) };
  }
  if (item.type === 'reasoning')
    return {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: item.text,
          ...(item.providerMetadata ? { providerOptions: item.providerMetadata } : {}),
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

function toMessagePart(part: StreamedModelMessagePart): any {
  if (part.type === 'text') return part;
  if (!part.image) throw new Error('AI SDK image message part requires an image');
  const data = typeof part.image === 'object' ? part.image.id : part.image;
  return {
    type: 'file',
    data,
    mediaType: mediaType(data),
    ...(part.detail ? { providerOptions: { detail: part.detail } } : {}),
  };
}

function messageText(part: StreamedModelMessagePart): string {
  if (part.type !== 'text') throw new Error('AI SDK system messages only support text');
  return part.text;
}

function toToolResult(output: string | readonly StreamedModelToolResultPart[]): any {
  if (typeof output === 'string') return { type: 'text', value: output };
  return { type: 'content', value: output.map(toToolResultPart) };
}

function toToolResultPart(part: StreamedModelToolResultPart): any {
  if (part.type === 'text') return part;
  const value: any = part.type === 'image' ? part.image : part.file;
  if (!value) throw new Error('AI SDK tool result part requires file or image data');
  if (typeof value === 'string') return { type: 'file-url', url: value };
  if ('data' in value)
    return {
      type: 'file-data',
      data: value.data,
      mediaType: value.mediaType ?? 'application/octet-stream',
      ...(value.filename ? { filename: value.filename } : {}),
    };
  if ('url' in value)
    return { type: 'file-url', url: value.url, ...(value.filename ? { filename: value.filename } : {}) };
  return {
    type: 'file-id',
    fileId: 'fileId' in value ? value.fileId : value.id,
    ...(value.filename ? { filename: value.filename } : {}),
  };
}

function toTool(tool: StreamedModelTurnRequest['tools'][number]) {
  return {
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.parameters,
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
  };
}

function toToolChoice(choice: NonNullable<StreamedModelTurnRequest['toolChoice']>) {
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
