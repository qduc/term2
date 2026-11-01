import { withConversationTiming } from '../provider-items.js';
import { observeProviderRequestDispatch } from '../../../../source/providers/request-dispatch.js';
import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
} from '../../../../source/contracts/streamed-model-turn.js';
import type { ModelEvent, ModelRequest } from '../index.js';
import { outputToItem, toModelError, itemToInput } from './conversion.js';

function stopReason(reason: string | undefined): 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' {
  if (reason === 'tool_calls' || reason === 'tool_use' || reason === 'function_call') return 'tool_use';
  if (reason === 'length' || reason === 'max_tokens') return 'max_tokens';
  if (reason === 'content_filter' || reason === 'refusal') return 'refusal';
  return 'end_turn';
}

export function toProviderRequest(request: ModelRequest, signal: AbortSignal): StreamedModelTurnRequest {
  const continuation = typeof request.continuation === 'string' ? request.continuation : undefined;
  return {
    instructions: request.instructions,
    ...(request.previousResponseId !== undefined
      ? { previousResponseId: request.previousResponseId }
      : continuation !== undefined
      ? { previousResponseId: continuation }
      : {}),
    input: request.input.flatMap((item) => withConversationTiming(item, itemToInput(item))),
    tools: request.tools.map((tool) =>
      tool.modelTool
        ? { type: tool.modelTool.type, name: tool.name, description: tool.description, format: tool.modelTool.format }
        : { type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema },
    ),
    ...(request.reasoning ? { reasoning: { effort: request.reasoning } } : {}),
    ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {}),
    signal,
    ...(request.disableChaining !== undefined ? { disableChaining: request.disableChaining } : {}),
  };
}

export async function* modelEvents(
  original: StreamedModelTurn,
  request: StreamedModelTurnRequest,
  provider: string,
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  const streamedToolCalls = new Map<string, Extract<StreamedModelTurnEvent, { type: 'tool_call' }>>();
  let completion: Extract<StreamedModelTurnEvent, { type: 'completion' }> | undefined;
  try {
    for await (const event of original.stream(request)) {
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
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
          streamedToolCalls.set(event.id, event);
          break;
        case 'completion': {
          completion = event;
          if (event.usage)
            yield {
              type: 'usage',
              usage: {
                inputTokens: event.usage.inputTokens ?? 0,
                outputTokens: event.usage.outputTokens ?? 0,
                cachedInputTokens: event.usage.cachedInputTokens ?? 0,
              },
            };
          const completedToolCalls = new Set<string>();
          for (const output of event.output) {
            if (output.type === 'tool_call') {
              const streamed = streamedToolCalls.get(output.id);
              if (streamed) completedToolCalls.add(output.id);
              const completeCall = streamed
                ? {
                    ...streamed,
                    ...output,
                    ...(output.providerMetadata !== undefined || streamed.providerMetadata === undefined
                      ? {}
                      : { providerMetadata: streamed.providerMetadata }),
                    ...(streamed.toolType ? { toolType: streamed.toolType } : {}),
                  }
                : output;
              yield { type: 'item', item: outputToItem(completeCall, provider) };
            } else yield { type: 'item', item: outputToItem(output, provider) };
          }
          for (const [callId, streamed] of streamedToolCalls)
            if (!completedToolCalls.has(callId)) yield { type: 'item', item: outputToItem(streamed, provider) };
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
    if (!completion) {
      for (const streamed of streamedToolCalls.values()) yield { type: 'item', item: outputToItem(streamed, provider) };
      yield { type: 'done', stopReason: 'end_turn' };
    }
  } catch (error) {
    throw toModelError(error, signal);
  }
}

export function observedModelStream(
  original: StreamedModelTurn,
  request: ModelRequest,
  provider: string,
  signal: AbortSignal,
  onDispatched?: () => void,
) {
  return observeProviderRequestDispatch(
    modelEvents(original, toProviderRequest(request, signal), provider, signal),
    onDispatched,
  );
}
