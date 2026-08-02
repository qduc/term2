import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
} from '../contracts/streamed-model-turn.js';

type OpenAIStreamedModel = {
  getStreamedResponse(request: any): AsyncIterable<any>;
};

/** Adapt an OpenAI Responses model's SDK stream to the application turn protocol. */
export function adaptOpenAIStreamedModel(model: OpenAIStreamedModel): StreamedModelTurn {
  return {
    async *stream(request: StreamedModelTurnRequest): AsyncIterable<StreamedModelTurnEvent> {
      const legacyRequest = {
        ...(request.previousResponseId ? { previousResponseId: request.previousResponseId } : {}),
        input: request.input.map((item: any) =>
          item.type === 'tool_result'
            ? { type: 'function_call_result', callId: item.id, output: { text: item.output } }
            : item,
        ),
        tools: request.tools.map((tool) => ({ type: 'function', ...tool })),
        modelSettings: {
          ...(request.toolChoice !== undefined ? { toolChoice: toLegacyToolChoice(request.toolChoice) } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.topP !== undefined ? { topP: request.topP } : {}),
          ...(request.frequencyPenalty !== undefined ? { frequencyPenalty: request.frequencyPenalty } : {}),
          ...(request.presencePenalty !== undefined ? { presencePenalty: request.presencePenalty } : {}),
          ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
          ...(request.reasoning ? { reasoning: request.reasoning } : {}),
          ...(request.providerOptions ? { providerData: request.providerOptions } : {}),
        },
        systemInstructions: request.instructions,
        handoffs: [],
        outputType: 'text',
        tracing: false,
        signal: request.signal,
      };
      let completion: any;
      for await (const event of model.getStreamedResponse(legacyRequest)) {
        if (event?.type === 'output_text_delta') yield { type: 'text_delta', text: event.delta ?? '' };
        else if (event?.type === 'model' && event.event?.type === 'codex.rate_limits') {
          const rateLimits = event.event.rate_limits ?? event.event;
          if (rateLimits && typeof rateLimits === 'object') yield { type: 'codex_rate_limits', rateLimits };
        } else if (event?.type === 'response_done') completion = event.response;
        else if (event?.type === 'response.completed') completion = event.response;
      }
      // A stream ending without a terminal response must remain visible as a provider failure.
      if (!completion) throw new Error('OpenAI streamed response ended without a completion.');
      const output = completion?.output ?? [];
      yield {
        type: 'completion',
        responseId: completion?.id ?? `response-${Date.now()}`,
        output: output.map(toTurnOutput),
        usage: completion?.usage,
      };
    },
  };
}

function toTurnOutput(item: any): Extract<StreamedModelTurnEvent, { type: 'completion' }>['output'][number] {
  if (item?.type === 'function_call') {
    return {
      type: 'tool_call',
      id: item.callId ?? item.call_id,
      name: item.name,
      arguments: item.arguments ?? '{}',
    };
  }
  if (item?.type === 'message') {
    const content = Array.isArray(item.content) ? item.content : [];
    return {
      type: 'message',
      content: content
        .filter((part: any) => part?.type === 'output_text' || part?.type === 'text')
        .map((part: any) => ({ type: 'text' as const, text: String(part.text ?? '') })),
    };
  }
  if (item?.type === 'reasoning') {
    const content = Array.isArray(item.content) && item.content.length > 0 ? item.content : item.rawContent ?? [];
    const text = content
      .filter((part: any) => part?.type === 'input_text' || part?.type === 'reasoning_text' || part?.type === 'text')
      .map((part: any) => String(part.text ?? ''))
      .join('');
    return {
      type: 'reasoning',
      ...(item.id ? { id: String(item.id) } : {}),
      text,
      ...(item.providerData ? { providerMetadata: item.providerData } : {}),
    };
  }
  throw new Error(`Unsupported OpenAI response output item: ${String(item?.type ?? 'unknown')}`);
}

function toLegacyToolChoice(choice: NonNullable<StreamedModelTurnRequest['toolChoice']>): unknown {
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice;
  return { type: 'function', name: choice.name };
}
