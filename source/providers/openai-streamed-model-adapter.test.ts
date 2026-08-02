import { expect, it } from 'vitest';
import { adaptOpenAIStreamedModel, toOpenAILegacyInput } from './openai-streamed-model-adapter.js';

async function collect(stream: AsyncIterable<unknown>) {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

it('shares the legacy tool-result projection used by the adapter boundary', () => {
  expect(toOpenAILegacyInput([{ type: 'tool_result', id: 'call-1', output: 'done' } as any])).toEqual([
    { type: 'function_call_result', callId: 'call-1', output: { text: 'done' } },
  ]);
});

it('throws when an OpenAI stream ends without a completion', async () => {
  const turn = adaptOpenAIStreamedModel({
    async *getStreamedResponse() {
      // no terminal event
    },
  });
  await expect(collect(turn.stream({ input: [], tools: [] } as any))).rejects.toThrow('ended without a completion');
});

it('forwards text and converts the completed Responses output', async () => {
  const turn = adaptOpenAIStreamedModel({
    async *getStreamedResponse() {
      yield { type: 'output_text_delta', delta: 'hi' };
      yield {
        type: 'response_done',
        response: {
          id: 'resp_1',
          output: [{ type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' }],
          usage: {},
        },
      };
    },
  });
  await expect(collect(turn.stream({ input: [], tools: [] } as any))).resolves.toEqual([
    { type: 'text_delta', text: 'hi' },
    {
      type: 'completion',
      responseId: 'resp_1',
      output: [{ type: 'tool_call', id: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' }],
      usage: {},
    },
  ]);
});

it('normalizes completed message and reasoning output into the application contract', async () => {
  const turn = adaptOpenAIStreamedModel({
    async *getStreamedResponse() {
      yield {
        type: 'response_done',
        response: {
          id: 'resp_output',
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
            {
              type: 'reasoning',
              id: 'reasoning-1',
              content: [],
              rawContent: [{ type: 'reasoning_text', text: 'thought' }],
              providerData: { openai: { encrypted_content: 'ciphertext' } },
            },
          ],
        },
      };
    },
  });

  await expect(collect(turn.stream({ input: [], tools: [] } as any))).resolves.toEqual([
    {
      type: 'completion',
      responseId: 'resp_output',
      output: [
        { type: 'message', content: [{ type: 'text', text: 'answer' }] },
        {
          type: 'reasoning',
          id: 'reasoning-1',
          text: 'thought',
          providerMetadata: { openai: { encrypted_content: 'ciphertext' } },
        },
      ],
      usage: undefined,
    },
  ]);
});

it('preserves typed settings and provider options at the OpenAI model seam', async () => {
  let capturedRequest: any;
  const turn = adaptOpenAIStreamedModel({
    async *getStreamedResponse(request) {
      capturedRequest = request;
      yield { type: 'response_done', response: { id: 'resp_settings', output: [] } };
    },
  });

  await collect(
    turn.stream({
      input: [],
      tools: [],
      previousResponseId: 'resp-previous',
      toolChoice: { name: 'shell' },
      topP: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      maxTokens: 0,
      providerOptions: { openai: { extraBody: { reasoning_effort: 'high' } } },
    } as any),
  );

  expect(capturedRequest).toMatchObject({
    previousResponseId: 'resp-previous',
    modelSettings: {
      toolChoice: { type: 'function', name: 'shell' },
      topP: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      maxTokens: 0,
      providerData: { openai: { extraBody: { reasoning_effort: 'high' } } },
    },
  });
});

it('forwards Codex plan limits emitted as model events', async () => {
  const rateLimits = {
    allowed: true,
    limit_reached: false,
    primary: { used_percent: 11, window_minutes: 300, reset_after_seconds: 60, reset_at: 1_700_000_000 },
    secondary: { used_percent: 14, window_minutes: 10_080, reset_after_seconds: 120, reset_at: 1_700_000_100 },
  };
  const turn = adaptOpenAIStreamedModel({
    async *getStreamedResponse() {
      yield { type: 'model', event: { type: 'codex.rate_limits', rate_limits: rateLimits } };
      yield { type: 'response_done', response: { id: 'resp-rate-limit', output: [] } };
    },
  });

  await expect(collect(turn.stream({ input: [], tools: [] } as any))).resolves.toContainEqual({
    type: 'codex_rate_limits',
    rateLimits,
  });
});
