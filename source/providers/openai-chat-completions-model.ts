import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
} from '../contracts/streamed-model-turn.js';

/** Application-owned adapter for OpenAI-compatible chat-completions endpoints. */
export class OpenAIChatCompletionsModel implements StreamedModelTurn {
  constructor(private readonly client: any, private readonly model: string) {}

  getModel(): this {
    return this;
  }

  // createCustomProviderModelProvider() (openai-compatible.provider.ts) returns
  // this class for the 'openai'/'openai-compatible'/'llama.cpp' provider types,
  // and every caller requires a `getStreamedModel()` method — the class already
  // implements StreamedModelTurn directly via `stream()`, so it just returns itself.
  getStreamedModel(): this {
    return this;
  }

  async getResponse(request: any): Promise<any> {
    if (request.modelSettings) return this.#legacyResponse(request);
    const events: any[] = [];
    for await (const event of this.stream(request as StreamedModelTurnRequest)) events.push(event);
    const completion = events.find((event) => event.type === 'completion');
    return { responseId: completion?.responseId, output: completion?.output ?? [], usage: completion?.usage };
  }

  getStreamedResponse(request: any): AsyncIterable<any> {
    if (request.modelSettings) return this.#legacyStream(request);
    return this.stream(request as StreamedModelTurnRequest);
  }

  async #legacyResponse(request: any): Promise<any> {
    const response = await this.client.chat.completions.create(this.#legacyBody(request, false));
    return {
      responseId: response?.id,
      output: legacyOutput(response?.choices?.[0]?.message),
      usage: response?.usage,
    };
  }

  async *#legacyStream(request: any): AsyncIterable<any> {
    const response = await this.client.chat.completions.create(this.#legacyBody(request, true));
    let text = '';
    let reasoning = '';
    // Keyed by the tool call's stream `index`, which every provider sends on
    // every chunk. `id` (and often `name`) only arrives on the first chunk for
    // that index; later chunks carry just `{ index, function: { arguments } }`
    // with no `id`. Keying by `id ?? index` used to split one tool call into
    // two accumulator entries once the id-less chunks fell back to the index key.
    const calls = new Map<number, { id?: string; name: string; arguments: string }>();
    for await (const chunk of response) {
      const delta = chunk?.choices?.[0]?.delta;
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      if (delta?.content) {
        text += delta.content;
        yield { type: 'output_text_delta', delta: delta.content };
      }
      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = calls.get(index) ?? { name: '', arguments: '' };
        if (call.id) current.id = call.id;
        current.name += call.function?.name ?? '';
        current.arguments += call.function?.arguments ?? '';
        calls.set(index, current);
      }
    }
    const output = reasoning
      ? [
          { type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: reasoning }] },
          ...(text ? [{ type: 'message', content: [{ type: 'output_text', text }] }] : []),
        ]
      : calls.size
      ? [...calls].map(([index, call]) => ({
          type: 'function_call',
          callId: call.id ?? `call_${index}`,
          name: call.name,
          arguments: call.arguments,
        }))
      : [{ type: 'message', content: [{ type: 'output_text', text }] }];
    yield { type: 'response_done', response: { id: `chatcmpl-${Date.now()}`, output } };
  }

  #legacyBody(request: any, stream: boolean): any {
    const settings = request.modelSettings ?? {};
    const body = {
      model: this.model,
      messages: legacyMessages(request.input ?? []),
      stream,
      ...(request.tools?.length
        ? { tools: request.tools.map((tool: any) => ({ type: 'function', function: tool })) }
        : {}),
      ...(settings.reasoning?.effort ? { reasoning_effort: settings.reasoning.effort } : {}),
      ...(settings.providerData ?? {}),
      signal: request.signal,
    };
    return body;
  }

  async *stream(request: StreamedModelTurnRequest): AsyncIterable<StreamedModelTurnEvent> {
    const messages = request.input.map((item: any) => {
      if (item.type === 'message') {
        const content =
          typeof item.content === 'string'
            ? item.content
            : item.content.map((part: any) => {
                if (typeof part === 'string') return { type: 'text', text: part };
                if (part?.type === 'image') {
                  const image = part.image;
                  const url = typeof image === 'string' ? image : image?.id;
                  return { type: 'image_url', image_url: { url } };
                }
                return { type: 'text', text: part?.text ?? '' };
              });
        return { role: item.role, content };
      }
      if (item.type === 'tool_call')
        return {
          role: 'assistant',
          tool_calls: [{ id: item.id, type: 'function', function: { name: item.name, arguments: item.arguments } }],
        };
      if (item.type === 'tool_result')
        return {
          role: 'tool',
          tool_call_id: item.id,
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
        };
      return { role: 'assistant', content: item.text };
    });
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: tool })) } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.reasoning?.effort ? { reasoning_effort: request.reasoning.effort } : {}),
      ...(request.providerOptions ?? {}),
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
    for await (const chunk of response) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content;
        yield { type: 'reasoning_delta', text: delta.reasoning_content };
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
        current.arguments += call.function?.arguments ?? '';
        calls.set(index, current);
      }
      if (chunk.usage) {
        // Usage is emitted on completion below; providers may omit it in-stream.
      }
    }
    for (const [index, call] of calls)
      yield { type: 'tool_call', id: call.id ?? `call_${index}`, name: call.name, arguments: call.arguments };
    yield {
      type: 'completion',
      responseId: `chatcmpl-${Date.now()}`,
      output: [
        ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []),
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

function legacyMessages(input: any[]): any[] {
  const result: any[] = [];
  let pendingReasoning: string | undefined;
  for (const item of input) {
    if (!item) continue;
    if (item.type === 'reasoning') {
      pendingReasoning = (item.rawContent ?? item.content ?? []).map((part: any) => part.text ?? '').join('');
      continue;
    }
    if (item.type === 'function_call') {
      result.push({
        role: 'assistant',
        content: null,
        ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}),
        tool_calls: [
          {
            id: item.callId ?? item.call_id,
            type: 'function',
            function: { name: item.name, arguments: item.arguments },
          },
        ],
      });
      pendingReasoning = undefined;
      continue;
    }
    if (item.type === 'function_call_result') {
      result.push({
        role: 'tool',
        content: [{ type: 'text', text: String(item.output ?? ''), cache_control: { type: 'ephemeral' } }],
        tool_call_id: item.callId ?? item.call_id,
      });
      continue;
    }
    const content =
      typeof item.content === 'string'
        ? [{ type: 'text', text: item.content, cache_control: { type: 'ephemeral' } }]
        : item.content;
    result.push({ role: item.role ?? 'user', content });
  }
  return result;
}

function legacyOutput(message: any): any[] {
  if (!message) return [];
  const output: any[] = [];
  if (message.reasoning_content)
    output.push({
      type: 'reasoning',
      content: [],
      rawContent: [{ type: 'reasoning_text', text: message.reasoning_content }],
    });
  if (message.content) output.push({ type: 'message', content: [{ type: 'output_text', text: message.content }] });
  for (const call of message.tool_calls ?? [])
    output.push({
      type: 'function_call',
      callId: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments ?? '{}',
    });
  return output;
}
