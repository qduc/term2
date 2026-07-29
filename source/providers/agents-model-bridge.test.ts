import { expect, it } from 'vitest';
import { Agent, Runner } from '@openai/agents';
import type { ModelRequest } from '@openai/agents-core';
import { adaptStreamedModelTurnForAgents } from './agents-model-bridge.js';
import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnRequest,
} from '../contracts/streamed-model-turn.js';

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    input: 'hello',
    modelSettings: {},
    tools: [],
    handoffs: [],
    outputType: 'text',
    tracing: false,
    ...overrides,
  } as ModelRequest;
}

async function collect(stream: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

it('translates message parts, settings, provider options, and signal without collapsing content', async () => {
  let seen: StreamedModelTurnRequest | undefined;
  const applicationModel: StreamedModelTurn = {
    async *stream(turn) {
      seen = turn;
      yield {
        type: 'completion',
        responseId: 'response-1',
        output: [
          { type: 'reasoning', id: 'thought-1', text: 'Think.', providerMetadata: { anthropic: { signature: 'sig' } } },
          { type: 'message', content: [{ type: 'text', text: 'Done.' }] },
          { type: 'tool_call', id: 'call-1', name: 'shell', arguments: '{"command":"printf(\\"  exact  \\")"}' },
        ],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 4 },
      };
    },
  };
  const signal = new AbortController().signal;
  const model = adaptStreamedModelTurnForAgents(applicationModel);

  const events = await collect(
    model.getStreamedResponse(
      request({
        systemInstructions: 'Be concise.',
        signal,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'List files.' },
              { type: 'input_image', image: 'data:image/png;base64,aW1n', detail: 'auto' },
            ],
          },
          {
            type: 'reasoning',
            id: 'prior-thought',
            content: [{ type: 'input_text', text: 'Earlier.' }],
            providerData: { anthropic: { signature: 'old' } },
          },
          {
            type: 'function_call',
            callId: 'old-call',
            name: 'shell',
            arguments: '{"command":"pwd"}',
            status: 'completed',
          },
          {
            type: 'function_call_result',
            callId: 'old-call',
            name: 'shell',
            status: 'completed',
            output: [
              { type: 'input_text', text: 'ok' },
              { type: 'input_image', image: 'image-1' },
              { type: 'input_file', file: { url: 'file:///tmp/out' }, filename: 'out.txt' },
            ],
          },
        ],
        tools: [
          {
            type: 'function',
            name: 'shell',
            description: 'Run shell.',
            parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
            strict: true,
          },
        ],
        modelSettings: {
          toolChoice: 'shell',
          temperature: 0,
          topP: 0,
          frequencyPenalty: 0,
          presencePenalty: 0,
          maxTokens: 0,
          reasoning: { effort: 'high' },
          providerData: { openrouter: { transforms: ['middle-out'] } },
        },
      }),
    ),
  );

  expect(seen).toEqual({
    instructions: 'Be concise.',
    signal,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: 'List files.' },
          { type: 'image', image: 'data:image/png;base64,aW1n', detail: 'auto' },
        ],
      },
      {
        type: 'reasoning',
        id: 'prior-thought',
        text: 'Earlier.',
        providerMetadata: { anthropic: { signature: 'old' } },
      },
      { type: 'tool_call', id: 'old-call', name: 'shell', arguments: '{"command":"pwd"}' },
      {
        type: 'tool_result',
        id: 'old-call',
        output: [
          { type: 'text', text: 'ok' },
          { type: 'image', image: 'image-1' },
          { type: 'file', file: { url: 'file:///tmp/out', filename: 'out.txt' } },
        ],
      },
    ],
    tools: [
      {
        name: 'shell',
        description: 'Run shell.',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        strict: true,
      },
    ],
    toolChoice: { name: 'shell' },
    temperature: 0,
    topP: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    maxTokens: 0,
    reasoning: { effort: 'high' },
    providerOptions: { openrouter: { transforms: ['middle-out'] } },
  });
  expect(events.map((event: any) => event.type)).toEqual(['response_started', 'response_done']);
  expect((events.at(-1) as any).response).toMatchObject({
    id: 'response-1',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokensDetails: [{ cached_tokens: 0, cache_write_tokens: 4 }],
    },
    output: [
      {
        type: 'reasoning',
        id: 'thought-1',
        content: [{ type: 'input_text', text: 'Think.' }],
        rawContent: [{ type: 'reasoning_text', text: 'Think.' }],
        providerData: { anthropic: { signature: 'sig' } },
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }], status: 'completed' },
      {
        type: 'function_call',
        callId: 'call-1',
        name: 'shell',
        arguments: '{"command":"printf(\\"  exact  \\")"}',
        status: 'completed',
      },
    ],
  });
});

it('forwards deltas before the application stream completes', async () => {
  let releaseCompletion!: () => void;
  const completionGate = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  const model = adaptStreamedModelTurnForAgents({
    async *stream() {
      yield { type: 'text_delta', text: 'live' };
      await completionGate;
      yield { type: 'completion', responseId: 'response-live', output: [] };
    },
  });
  const iterator = model.getStreamedResponse(request())[Symbol.asyncIterator]();

  await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'response_started' }, done: false });
  await expect(iterator.next()).resolves.toMatchObject({
    value: { type: 'output_text_delta', delta: 'live' },
    done: false,
  });

  const pendingCompletion = iterator.next();
  let settled = false;
  void pendingCompletion.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);

  releaseCompletion();
  await expect(pendingCompletion).resolves.toMatchObject({ value: { type: 'response_done' }, done: false });
});

it('drives a real streaming Runner through the temporary bridge', async () => {
  const model = adaptStreamedModelTurnForAgents({
    async *stream() {
      yield { type: 'text_delta', text: 'Runner done.' };
      yield {
        type: 'completion',
        responseId: 'response-runner',
        output: [{ type: 'message', content: [{ type: 'text', text: 'Runner done.' }] }],
      };
    },
  });
  const runner = new Runner({ modelProvider: { getModel: () => model } });
  const agent = new Agent({ name: 'streamed-turn-bridge-test', instructions: 'Reply.', model: 'bridge-model' });

  const stream = await runner.run(agent, 'hello', { stream: true });
  for await (const _event of stream) {
    // Consume the SDK stream so the Runner observes the terminal response.
  }
  await stream.completed;

  expect(stream.finalOutput).toBe('Runner done.');
});

it('emits reasoning and tool-call deltas through public model events and makes completion authoritative', async () => {
  const model = adaptStreamedModelTurnForAgents({
    async *stream() {
      yield {
        type: 'reasoning_delta',
        id: 'thought-1',
        text: 'Think.',
        providerMetadata: { anthropic: { signature: 'sig' } },
      };
      yield { type: 'text_delta', text: 'Not authoritative.' };
      yield { type: 'tool_call', id: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' };
      yield {
        type: 'completion',
        responseId: 'response-2',
        output: [{ type: 'tool_call', id: 'call-1', name: 'shell', arguments: '{"command":"pwd"}' }],
      };
    },
  });
  const events = await collect(model.getStreamedResponse(request()));
  expect(events).toMatchObject([
    { type: 'response_started' },
    {
      type: 'model',
      event: {
        type: 'reasoning-delta',
        id: 'thought-1',
        delta: 'Think.',
        providerMetadata: { anthropic: { signature: 'sig' } },
      },
    },
    { type: 'output_text_delta', delta: 'Not authoritative.' },
    {
      type: 'model',
      event: { type: 'tool-call', toolCallId: 'call-1', toolName: 'shell', input: '{"command":"pwd"}' },
    },
    {
      type: 'response_done',
      response: {
        id: 'response-2',
        output: [
          {
            type: 'function_call',
            callId: 'call-1',
            name: 'shell',
            arguments: '{"command":"pwd"}',
            status: 'completed',
          },
        ],
      },
    },
  ]);
});

it('implements getResponse by consuming the same streamed operation and distinguishes missing from zero usage details', async () => {
  let calls = 0;
  const model = adaptStreamedModelTurnForAgents({
    async *stream() {
      calls++;
      yield {
        type: 'completion',
        responseId: 'response-3',
        output: [{ type: 'message', content: [{ type: 'text', text: 'Complete.' }] }],
      };
    },
  });
  const response = await model.getResponse(request());
  expect(response.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  expect(response.usage.inputTokensDetails).toEqual([]);
  expect(response.responseId).toBe('response-3');
  expect(calls).toBe(1);
});

it('preserves zero usage details', async () => {
  const model = adaptStreamedModelTurnForAgents({
    async *stream() {
      yield {
        type: 'completion',
        responseId: 'response-4',
        output: [],
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
      };
    },
  });
  const response = await model.getResponse(request());
  expect(response.usage.inputTokensDetails).toEqual([{ cached_tokens: 0, cache_write_tokens: 0 }]);
});

it('rejects missing, duplicate, and post-completion events before publishing response_done', async () => {
  const noCompletion = adaptStreamedModelTurnForAgents({
    async *stream() {
      yield { type: 'text_delta', text: 'partial' };
    },
  });
  const duplicate = adaptStreamedModelTurnForAgents({
    async *stream() {
      yield { type: 'completion', responseId: 'one', output: [] };
      yield { type: 'completion', responseId: 'two', output: [] };
    },
  });
  const afterCompletion = adaptStreamedModelTurnForAgents({
    async *stream() {
      yield { type: 'completion', responseId: 'one', output: [] };
      yield { type: 'text_delta', text: 'late' };
    },
  });
  await expect(collect(noCompletion.getStreamedResponse(request()))).rejects.toThrow('without completion');
  await expect(collect(duplicate.getStreamedResponse(request()))).rejects.toThrow('after completion');
  await expect(collect(afterCompletion.getStreamedResponse(request()))).rejects.toThrow('after completion');
});

it('propagates application failures and rejects unsupported SDK shapes', async () => {
  const failure = new Error('provider failed');
  const model = adaptStreamedModelTurnForAgents({
    // eslint-disable-next-line require-yield
    async *stream() {
      throw failure;
    },
  });
  await expect(collect(model.getStreamedResponse(request()))).rejects.toBe(failure);
  await expect(collect(model.getStreamedResponse(request({ previousResponseId: 'not-supported' })))).rejects.toThrow(
    'previousResponseId',
  );
  await expect(
    collect(
      model.getStreamedResponse(
        request({
          input: [{ type: 'message', role: 'user', content: [{ type: 'audio', audio: 'nope' }] }],
        } as unknown as ModelRequest),
      ),
    ),
  ).rejects.toThrow('message content');
  await expect(
    collect(
      model.getStreamedResponse(
        request({
          input: [{ type: 'message', role: 'system', content: [{ type: 'input_image', image: 'nope' }] }],
        } as unknown as ModelRequest),
      ),
    ),
  ).rejects.toThrow('system message content');
  await expect(
    collect(model.getStreamedResponse(request({ tools: [{ type: 'computer' }] } as unknown as ModelRequest))),
  ).rejects.toThrow('tool type');
});
