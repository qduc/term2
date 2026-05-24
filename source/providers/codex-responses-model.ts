import { OpenAIResponsesModel } from '@openai/agents-openai';

// Codex's `/backend-api/codex/responses` endpoint ships `response.completed`
// with an empty `output` array even when the assistant message was already
// delivered via `response.output_item.done`. The agents-SDK runner trusts
// `response.completed.response.output` as the final output; with an empty
// array it sees no items, decides the turn produced nothing, and re-runs the
// same request until maxTurns — an infinite-retry loop.
//
// This wrapper subclasses `OpenAIResponsesModel`, overrides the streaming
// fetch path, and patches the terminal frame in flight: it accumulates raw
// items from `response.output_item.done` and, only when the terminal
// `response.output` is empty, swaps in the accumulated items so the parent's
// existing conversion logic (`convertToOutputItem`) produces a normal
// `response_done` event.
export class CodexResponsesModel extends OpenAIResponsesModel {
  async _fetchResponse(request: any, stream: boolean): Promise<any> {
    const response = await (OpenAIResponsesModel.prototype as any)._fetchResponse.call(this, request, stream);
    if (!stream) return response;
    return wrapCodexStream(response);
  }
}

export async function* wrapCodexStream(source: AsyncIterable<any>): AsyncIterable<any> {
  const accumulatedItems: any[] = [];
  for await (let event of source) {
    const type = event?.type;
    if (type === 'response.output_item.done' && event.item) {
      accumulatedItems.push(event.item);
    } else if (type === 'response.completed' && event.response) {
      const output = event.response.output;
      if (Array.isArray(output) && output.length === 0 && accumulatedItems.length > 0) {
        try {
          event.response.output = accumulatedItems;
        } catch {
          // Response object may be frozen; clone with the reconstructed output.
          event = { ...event, response: { ...event.response, output: accumulatedItems } };
        }
      }
    }
    yield event;
  }
}
