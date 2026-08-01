import type { Model, ModelRequest, ModelResponse } from '../contracts/model.js';
import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnInput,
  StreamedModelMessagePart,
  StreamedModelTextPart,
  StreamedModelTurnOutput,
  StreamedModelToolResultPart,
  StreamedModelTurnRequest,
} from '../contracts/streamed-model-turn.js';

type AgentInputItem = any;
type AgentOutputItem = any;
type FunctionCallResultItem = any;
type ResponseStreamEvent = any;
type ResponseDoneEvent = any;

/** Temporary compatibility boundary from the SDK Model protocol to one application turn. */
export function adaptStreamedModelTurnForAgents(applicationModel: StreamedModelTurn): Model {
  return {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      if (typeof (applicationModel as any).getResponse === 'function') {
        return toModelResponse(await (applicationModel as any).getResponse(toStreamedModelTurnRequest(request)));
      }
      return toModelResponse(
        (await consumeCompletion(applicationModel, toStreamedModelTurnRequest(request))).completion,
      );
    },

    async *getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
      const turn = toStreamedModelTurnRequest(request);
      let started = false;
      let completion: Extract<StreamedModelTurnEvent, { type: 'completion' }> | undefined;
      for await (const event of applicationModel.stream(turn)) {
        if (completion) throw new Error('Streamed model turn emitted an event after completion');
        if (event.type === 'completion') {
          completion = event;
          continue;
        }
        if (!started) {
          started = true;
          yield { type: 'response_started' };
        }
        if (event.type === 'text_delta') {
          yield { type: 'output_text_delta', delta: event.text };
        } else if (event.type === 'reasoning_delta') {
          yield { type: 'model', event: toReasoningModelEvent(event) };
        } else if (event.type === 'tool_call') {
          yield {
            type: 'model',
            event: { type: 'tool-call', toolCallId: event.id, toolName: event.name, input: event.arguments },
          };
        }
      }
      if (!completion) throw new Error('Streamed model turn ended without completion');
      if (!started) yield { type: 'response_started' };
      const response = toModelResponse(completion);
      yield {
        type: 'response_done',
        response: {
          id: completion.responseId,
          usage: response.usage,
          // ModelResponse permits input items, while response_done correctly permits only
          // model output items. This bridge constructs output-only items in toOutput().
          output: response.output as ResponseDoneEvent['response']['output'],
          ...(response.providerData ? { providerData: response.providerData } : {}),
        },
      };
    },
  };
}

function toStreamedModelTurnRequest(request: ModelRequest): StreamedModelTurnRequest {
  rejectUnsupportedRequestFields(request);
  const { modelSettings } = request;
  return {
    ...(request.systemInstructions ? { instructions: request.systemInstructions } : {}),
    input:
      typeof request.input === 'string'
        ? [{ type: 'message', role: 'user', content: [{ type: 'text', text: request.input }] }]
        : (request.input as any[]).flatMap(toInput),
    tools: request.tools.map(toTool),
    ...(toToolChoice(modelSettings.toolChoice) ? { toolChoice: toToolChoice(modelSettings.toolChoice) } : {}),
    ...(modelSettings.temperature !== undefined ? { temperature: modelSettings.temperature } : {}),
    ...(modelSettings.topP !== undefined ? { topP: modelSettings.topP } : {}),
    ...(modelSettings.frequencyPenalty !== undefined ? { frequencyPenalty: modelSettings.frequencyPenalty } : {}),
    ...(modelSettings.presencePenalty !== undefined ? { presencePenalty: modelSettings.presencePenalty } : {}),
    ...(modelSettings.maxTokens !== undefined ? { maxTokens: modelSettings.maxTokens } : {}),
    ...(modelSettings.reasoning ? { reasoning: modelSettings.reasoning } : {}),
    ...(modelSettings.providerData ? { providerOptions: modelSettings.providerData } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

function rejectUnsupportedRequestFields(request: ModelRequest) {
  if (request.previousResponseId !== undefined) throw new Error('Unsupported ModelRequest field: previousResponseId');
  if (request.conversationId !== undefined) throw new Error('Unsupported ModelRequest field: conversationId');
  if (request.prompt !== undefined) throw new Error('Unsupported ModelRequest field: prompt');
  if (request.handoffs.length) throw new Error('Unsupported ModelRequest handoffs');
  if (request.outputType !== 'text') throw new Error('Unsupported ModelRequest output type');
}

function toInput(item: AgentInputItem): StreamedModelTurnInput[] {
  if (item && typeof item.role === 'string' && item.content !== undefined && !item.type) {
    const content =
      typeof item.content === 'string'
        ? [{ type: 'text' as const, text: item.content }]
        : Array.isArray(item.content)
        ? item.content.map(toMessagePart)
        : [{ type: 'text' as const, text: String(item.content) }];
    return [{ type: 'message', role: item.role, content } as any];
  }
  if (item.type === 'message') {
    if (!['user', 'assistant', 'system'].includes(item.role)) throw new Error(`Unsupported message role: ${item.role}`);
    const content =
      typeof item.content === 'string'
        ? [{ type: 'text' as const, text: item.content }]
        : item.content.map(toMessagePart);
    if (item.role === 'system') {
      if (!content.every(isTextPart)) throw new Error('Unsupported system message content: only text is supported');
      return [{ type: 'message', role: 'system', content }];
    }
    return item.role === 'user'
      ? [{ type: 'message', role: 'user', content }]
      : [{ type: 'message', role: 'assistant', content }];
  }
  if (item.type === 'reasoning') {
    return [
      {
        type: 'reasoning',
        ...(item.id ? { id: item.id } : {}),
        text: item.content.map((content: any) => content.text).join(''),
        ...(item.providerData ? { providerMetadata: item.providerData } : {}),
      },
    ];
  }
  if (item.type === 'function_call')
    return [{ type: 'tool_call', id: item.callId, name: item.name, arguments: item.arguments }];
  if (item.type === 'function_call_result')
    return [{ type: 'tool_result', id: item.callId, output: toToolResultOutput(item) }];
  throw new Error(`Unsupported ModelRequest input item: ${item.type}`);
}

function toMessagePart(content: unknown): StreamedModelMessagePart {
  if (typeof content === 'string') return { type: 'text', text: content };
  if (!isRecord(content) || typeof content.type !== 'string') throw new Error('Unsupported message content');
  if (content.type === 'text' && typeof content.text === 'string') return { type: 'text', text: content.text };
  if ((content.type === 'input_text' || content.type === 'output_text') && typeof content.text === 'string')
    return { type: 'text', text: content.text };
  if (
    content.type === 'input_image' &&
    (content.image === undefined || typeof content.image === 'string' || isIdReference(content.image))
  ) {
    return {
      type: 'image',
      ...(content.image !== undefined ? { image: content.image } : {}),
      ...(typeof content.detail === 'string' ? { detail: content.detail } : {}),
    };
  }
  throw new Error(`Unsupported message content: ${content.type}`);
}

function isTextPart(part: StreamedModelMessagePart): part is StreamedModelTextPart {
  return part.type === 'text';
}

function toToolResultOutput(item: FunctionCallResultItem): string | readonly StreamedModelToolResultPart[] {
  if (typeof item.output === 'string') return item.output;
  const output = Array.isArray(item.output) ? item.output : [item.output];
  return output.map((part: any): StreamedModelToolResultPart => {
    if (part.type === 'text' || part.type === 'input_text') return { type: 'text', text: part.text };
    if (part.type === 'image' || part.type === 'input_image')
      return {
        type: 'image',
        ...(part.image !== undefined ? { image: part.image } : {}),
        ...(part.detail !== undefined ? { detail: part.detail } : {}),
      };
    if (part.type === 'file' || part.type === 'input_file') {
      const file = part.file!;
      const filename = part.type === 'input_file' ? part.filename : undefined;
      return {
        type: 'file',
        file: typeof filename === 'string' && isRecord(file) && !('filename' in file) ? { ...file, filename } : file,
      };
    }
    throw new Error('Unsupported function result part');
  });
}

function toTool(tool: ModelRequest['tools'][number]) {
  if (tool.type !== 'function') throw new Error(`Unsupported ModelRequest tool type: ${tool.type}`);
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters,
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
  };
}

function toToolChoice(choice: unknown): StreamedModelTurnRequest['toolChoice'] {
  if (choice === undefined || choice === 'auto' || choice === 'required' || choice === 'none') return choice;
  if (typeof choice === 'string') return { name: choice };
  throw new Error('Unsupported ModelRequest tool choice');
}

function toModelResponse(completion: Extract<StreamedModelTurnEvent, { type: 'completion' }>): ModelResponse {
  const inputTokens = completion.usage?.inputTokens ?? 0;
  const outputTokens = completion.usage?.outputTokens ?? 0;
  return {
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      inputTokensDetails:
        completion.usage?.cachedInputTokens !== undefined || completion.usage?.cacheWriteTokens !== undefined
          ? [
              {
                ...(completion.usage.cachedInputTokens !== undefined
                  ? { cached_tokens: completion.usage.cachedInputTokens }
                  : {}),
                ...(completion.usage.cacheWriteTokens !== undefined
                  ? { cache_write_tokens: completion.usage.cacheWriteTokens }
                  : {}),
              },
            ]
          : [],
    },
    output: completion.output.map(toOutput),
    responseId: completion.responseId,
    ...(completion.providerMetadata ? { providerData: completion.providerMetadata } : {}),
  };
}

function toOutput(output: StreamedModelTurnOutput): AgentOutputItem {
  if (output.type === 'message')
    return {
      type: 'message',
      role: 'assistant',
      content: output.content.map((part) => ({ type: 'output_text', text: part.text })),
      status: 'completed',
    };
  if (output.type === 'reasoning')
    return {
      type: 'reasoning',
      ...(output.id ? { id: output.id } : {}),
      content: [{ type: 'input_text', text: output.text }],
      rawContent: [{ type: 'reasoning_text', text: output.text }],
      ...(output.providerMetadata ? { providerData: output.providerMetadata } : {}),
    };
  return {
    type: 'function_call',
    callId: output.id,
    name: output.name,
    arguments: output.arguments,
    status: 'completed',
  };
}

function toReasoningModelEvent(event: Extract<StreamedModelTurnEvent, { type: 'reasoning_delta' }>) {
  return {
    type: 'reasoning-delta',
    ...(event.id ? { id: event.id } : {}),
    delta: event.text,
    ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}),
  };
}

async function consumeCompletion(
  applicationModel: StreamedModelTurn,
  request: StreamedModelTurnRequest,
): Promise<{ completion: Extract<StreamedModelTurnEvent, { type: 'completion' }> }> {
  let completion: Extract<StreamedModelTurnEvent, { type: 'completion' }> | undefined;
  for await (const event of applicationModel.stream(request)) {
    if (completion) throw new Error('Streamed model turn emitted an event after completion');
    if (event.type === 'completion') {
      completion = event;
      continue;
    }
  }
  if (!completion) throw new Error('Streamed model turn ended without completion');
  return { completion };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isIdReference(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === 'string';
}
