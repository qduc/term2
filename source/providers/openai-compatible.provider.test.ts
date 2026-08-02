import { it, expect } from 'vitest';
import type { StreamedModelTurnRequest } from '../contracts/streamed-model-turn.js';
const setTracingDisabled = (_disabled: boolean): void => {};
const withTrace = async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();
import {
  createCustomProviderModelProvider,
  createOpenAICompatibleProviderDefinition,
} from './openai-compatible.provider.js';
import { createOpenAICompatibleProviderDefinition as createLazyProviderDefinition } from './openai-compatible-lazy.js';
import type { ProviderDeps } from './registry.js';

setTracingDisabled(true);

const runUnderTrace = <T>(fn: () => Promise<T>): Promise<T> => withTrace('openai-compatible-provider-test', fn);

type CapturedRequest = {
  url: string;
  body: any;
  headers: Record<string, string>;
};

function buildProvider(
  captured: CapturedRequest[],
  response: any,
  providerType = 'openai-compatible',
  baseUrl = 'https://provider.test/v1',
  loggingService?: ProviderDeps['loggingService'],
  sessionContextService?: ProviderDeps['sessionContextService'],
) {
  return createCustomProviderModelProvider(
    {
      name: 'provider-test',
      type: providerType,
      baseUrl,
      apiKey: 'provider-key',
    },
    {
      defaultModel: 'provider-model',
      loggingService,
      sessionContextService,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        const rawHeaders = init?.headers as any;
        if (rawHeaders) {
          if (typeof rawHeaders.forEach === 'function') {
            rawHeaders.forEach((v: string, k: string) => {
              headers[k.toLowerCase()] = String(v);
            });
          } else {
            for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
              headers[k.toLowerCase()] = String(v);
            }
          }
        }
        const rawBody = typeof init?.body === 'string' ? init.body : '';
        const requestBody = rawBody ? JSON.parse(rawBody) : null;
        captured.push({
          url: typeof input === 'string' ? input : (input as URL).toString?.() ?? String(input),
          body: requestBody,
          headers,
        });
        if (response instanceof Response) {
          return response;
        }
        if (typeof response === 'function') {
          return response();
        }
        if (requestBody?.stream) {
          return streamedCompletionResponse(response);
        }
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    },
  );
}

const successResponse = {
  id: 'chatcmpl-provider-test',
  object: 'chat.completion',
  created: 1,
  model: 'provider-model',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

async function collectStreamEvents(model: any, request: StreamedModelTurnRequest): Promise<any[]> {
  const events: any[] = [];
  for await (const event of model.stream(request)) events.push(event);
  return events;
}

async function collectCompletion(model: any, request: StreamedModelTurnRequest): Promise<any> {
  const events = await collectStreamEvents(model, request);
  return events.find((event) => event.type === 'completion');
}

function streamedCompletionResponse(completion: any): Response {
  const choice = completion?.choices?.[0];
  const message = choice?.message ?? {};
  const deltas: any[] = [];
  if (message.reasoning_content) deltas.push({ reasoning_content: message.reasoning_content });
  if (message.content) deltas.push({ content: message.content });
  if (message.tool_calls?.length) deltas.push({ tool_calls: message.tool_calls });
  const frames = deltas.map((delta) => `data: ${JSON.stringify({ id: completion.id, choices: [{ delta }] })}`);
  frames.push(
    `data: ${JSON.stringify({ id: completion.id, choices: [{ delta: {}, finish_reason: choice.finish_reason }] })}`,
  );
  frames.push('data: [DONE]', '');
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames.join('\n\n')));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function streamedSuccessResponse(): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          [
            `data: ${JSON.stringify({ id: successResponse.id, choices: [{ delta: { content: 'ok' } }] })}`,
            `data: ${JSON.stringify({ id: successResponse.id, choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
            'data: [DONE]',
            '',
          ].join('\n\n'),
        ),
      );
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

it('runtime openai-compatible createStreamedModel returns a streamed model', () => {
  const provider = createOpenAICompatibleProviderDefinition({
    name: 'local-test',
    baseUrl: 'http://localhost:11434',
  });

  const deps: ProviderDeps = {
    settingsService: {
      get: (key: any) => {
        const values: Record<string, any> = {
          'agent.model': 'test-model',
          providers: [
            {
              name: 'local-test',
              baseUrl: 'http://localhost:11434',
              apiKey: 'local-key',
            },
          ],
        };
        return values[key];
      },
      getDynamic(key: string) {
        return this.get(key as any);
      },
      set() {},
      setDynamic() {},
      setPersistent() {},
      setPersistentDynamic() {},
    },
    loggingService: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      security: () => {},
      setCorrelationId: () => {},
      getCorrelationId: () => undefined,
      clearCorrelationId: () => {},
    },
  };

  const model = provider.createStreamedModel!('test-model', deps);

  expect(model).toBeTruthy();
  expect(model).toHaveProperty('stream');
});

it('resolves a stored provider config by legacy name alias when the stored id differs', async () => {
  const provider = createOpenAICompatibleProviderDefinition({
    name: 'alias-name',
  });

  let capturedUrl = '';
  const fakeFetch = async (url: string, _options?: any) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const deps: ProviderDeps = {
    settingsService: {
      get: (key: any) => {
        const values: Record<string, any> = {
          providers: [
            {
              id: 'stable-id',
              name: 'alias-name',
              type: 'openai-compatible',
              baseUrl: 'http://localhost:11434',
            },
          ],
        };
        return values[key];
      },
      getDynamic(key: string) {
        return this.get(key as any);
      },
      set() {},
      setDynamic() {},
      setPersistent() {},
      setPersistentDynamic() {},
    },
    loggingService: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      security: () => {},
      setCorrelationId: () => {},
      getCorrelationId: () => undefined,
      clearCorrelationId: () => {},
    },
  };

  const models = await provider.fetchModels(deps, fakeFetch);
  expect(capturedUrl).toContain('http://localhost:11434');
  expect(Array.isArray(models)).toBe(true);
});

it('providerData fields are forwarded into the chat-completions request body root', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getStreamedModel('provider-model');

  await runUnderTrace(() =>
    collectCompletion(model, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
      providerOptions: {
        service_tier: 'flex',
        custom_vendor_flag: 'on',
      },
    }),
  );

  expect(captured.length).toBe(1);
  const body = captured[0].body;
  expect(body.service_tier).toBe('flex');
  expect(body.custom_vendor_flag).toBe('on');
});

it('reasoning.effort is forwarded as reasoning_effort', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getStreamedModel('provider-model');

  await runUnderTrace(() =>
    collectCompletion(model, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
      reasoning: { effort: 'high', summary: 'auto' },
    }),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].body.reasoning_effort).toBe('high');
});

it('assistant reasoning_content is passed back with the following tool call', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getStreamedModel('claude-model');

  await runUnderTrace(() =>
    collectCompletion(model, {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'what time is it?' }] },
        {
          type: 'reasoning',
          text: 'Need to use the shell for the exact time.',
          providerMetadata: {
            reasoning_content: 'Need to use the shell for the exact time.',
            openai_compatible_reasoning_content: true,
          },
        },
        { type: 'tool_call', id: 'shell:0', name: 'shell', arguments: '{"command":"date"}' },
        { type: 'tool_result', id: 'shell:0', output: 'Tue May 12 18:40:41 +07 2026' },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'thanks' }] },
      ],
      tools: [],
    }),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].body.messages.slice(1, 4)).toEqual([
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'Need to use the shell for the exact time.',
      tool_calls: [
        {
          id: 'shell:0',
          type: 'function',
          function: {
            name: 'shell',
            arguments: '{"command":"date"}',
          },
        },
      ],
    },
    {
      role: 'tool',
      content: 'Tue May 12 18:40:41 +07 2026',
      tool_call_id: 'shell:0',
    },
    { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
  ]);
});

it('assistant reasoning_content from provider response is preserved as reasoning output', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, {
    ...successResponse,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'I will check.',
          reasoning_content: 'Need to inspect the project first.',
        },
        finish_reason: 'stop',
      },
    ],
  });
  const model = await provider.getStreamedModel('provider-model');

  const result = await runUnderTrace<any>(() =>
    collectCompletion(model, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
    }),
  );

  expect(result.output[0]).toEqual({
    type: 'reasoning',
    text: 'Need to inspect the project first.',
    providerMetadata: {
      reasoning_content: 'Need to inspect the project first.',
      openai_compatible_reasoning_content: true,
    },
  });
});

it('assistant reasoning_content from provider stream is preserved as reasoning output', async () => {
  const captured: CapturedRequest[] = [];
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          [
            'data: {"id":"chatcmpl-provider-test","choices":[{"delta":{"reasoning_content":"Need to stream reasoning."}}]}',
            'data: {"id":"chatcmpl-provider-test","choices":[{"delta":{"content":"ok"}}]}',
            'data: {"id":"chatcmpl-provider-test","choices":[{"delta":{},"finish_reason":"stop"}]}',
            'data: [DONE]',
            '',
          ].join('\n\n'),
        ),
      );
      controller.close();
    },
  });
  const provider = buildProvider(
    captured,
    new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  );
  const model = await provider.getStreamedModel('provider-model');

  const events = await collectStreamEvents(model, {
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
  });

  const finalEvent = events.find((event: any) => event.type === 'completion') as any;
  expect(finalEvent.output[0]).toEqual({
    type: 'reasoning',
    text: 'Need to stream reasoning.',
    providerMetadata: {
      reasoning_content: 'Need to stream reasoning.',
      openai_compatible_reasoning_content: true,
    },
  });
});

it('assistant choices with non-zero index in single-choice stream are normalized to 0', async () => {
  const captured: CapturedRequest[] = [];
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          [
            'data: {"id":"chatcmpl-provider-test","choices":[{"index":1,"delta":{"content":"Hello! How can I help you today?"}}]}',
            'data: {"id":"chatcmpl-provider-test","choices":[{"index":1,"delta":{},"finish_reason":"stop"}]}',
            'data: [DONE]',
            '',
          ].join('\n\n'),
        ),
      );
      controller.close();
    },
  });
  const provider = buildProvider(
    captured,
    new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  );
  const model = await provider.getStreamedModel('provider-model');

  const events = await collectStreamEvents(model, {
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
  });

  const finalEvent = events.find((event: any) => event.type === 'completion') as any;
  expect(finalEvent.output[0]).toEqual({
    type: 'message',
    content: [{ type: 'text', text: 'Hello! How can I help you today?' }],
  });
});

it('reasoning field is stripped and preserved only as reasoning_content in outgoing requests', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getStreamedModel('provider-model');

  await runUnderTrace(() =>
    collectCompletion(model, {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
        {
          type: 'reasoning',
          text: 'I should run date.',
          providerMetadata: { reasoning_content: 'I should run date.', openai_compatible_reasoning_content: true },
        },
        { type: 'tool_call', id: 'shell:0', name: 'shell', arguments: '{"command":"date"}' },
        { type: 'tool_result', id: 'shell:0', output: 'Mon Jan 01 00:00:00 UTC 2024' },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'thanks' }] },
      ],
      tools: [],
    }),
  );

  expect(captured.length).toBe(1);
  const assistantMsg = captured[0].body.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
  expect(assistantMsg).toBeTruthy();
  expect(assistantMsg.reasoning_content).toBe('I should run date.');
  expect('reasoning' in assistantMsg).toBe(false);
});

it('stray top-level index from replayed tool-call providerData is stripped from outgoing messages', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getStreamedModel('provider-model');

  await runUnderTrace(() =>
    collectCompletion(model, {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { type: 'tool_call', id: 'shell:0', name: 'shell', arguments: '{"command":"date"}' },
        { type: 'tool_result', id: 'shell:0', output: 'Mon Jan 01 00:00:00 UTC 2024' },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'thanks' }] },
      ],
      tools: [],
    }),
  );

  expect(captured.length).toBe(1);
  for (const message of captured[0].body.messages) {
    expect('index' in message).toBe(false);
  }
});

it('llama.cpp maps high reasoning effort to chat template kwargs', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'llama.cpp');
  const model = await provider.getStreamedModel('provider-model');

  await runUnderTrace(() =>
    collectCompletion(model, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
      reasoning: { effort: 'high', summary: 'auto' },
    }),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].body.reasoning_effort).toBe(undefined);
  expect(captured[0].body.chat_template_kwargs).toEqual({
    reasoning_effort: 'high',
    enable_thinking: true,
    thinking_mode: 'high',
    reasoning_budget: 8192,
  });
});

it('llama.cpp disables thinking for none reasoning effort', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'llama.cpp');
  const model = await provider.getStreamedModel('provider-model');

  await runUnderTrace(() =>
    collectCompletion(model, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
      reasoning: { effort: 'none', summary: 'auto' },
    }),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].body.reasoning_effort).toBe(undefined);
  expect(captured[0].body.chat_template_kwargs).toEqual({
    reasoning_effort: 'low',
    enable_thinking: false,
    thinking_mode: 'disabled',
    reasoning_budget: 0,
  });
});

it('llama.cpp maps xhigh to high template mode with xhigh budget', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'llama.cpp');
  const model = await provider.getStreamedModel('provider-model');

  await runUnderTrace(() =>
    collectCompletion(model, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
      reasoning: { effort: 'xhigh', summary: 'auto' },
    }),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].body.chat_template_kwargs).toEqual({
    reasoning_effort: 'high',
    enable_thinking: true,
    thinking_mode: 'high',
    reasoning_budget: 16384,
  });
});

it('llama.cpp leaves reasoning controls unset when effort is default', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'llama.cpp');
  const model = await provider.getStreamedModel('provider-model');

  await runUnderTrace(() =>
    collectCompletion(model, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
    }),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].body.reasoning_effort).toBe(undefined);
  expect(captured[0].body.chat_template_kwargs).toBe(undefined);
});

it('outgoing request hits the configured /chat/completions endpoint with bearer auth', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getStreamedModel('provider-model');

  await runUnderTrace(() =>
    collectCompletion(model, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
    }),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].url).toMatch(/\/chat\/completions(\?|$)/);
  expect(captured[0].headers.authorization).toBe('Bearer provider-key');
  expect(captured[0].body.model).toBe('provider-model');
});

it('opencode.ai baseUrl adds x-opencode-session header', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'openai-compatible', 'https://opencode.ai/v1');
  const model = await provider.getStreamedModel('provider-model');

  await runUnderTrace(() =>
    collectCompletion(model, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
    }),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].headers['x-opencode-session']).toBeTruthy();
  expect(captured[0].headers['x-opencode-session']).toMatch(/^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
  expect(captured[0].headers['x-opencode-session'].length, 'session ID should be exactly 30 characters').toBe(30);
});

it('opencode session ID is stable across requests within a session', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'openai-compatible', 'https://opencode.ai/v1');
  const model = await provider.getStreamedModel('provider-model');

  const makeRequest = () =>
    runUnderTrace(() =>
      collectCompletion(model, {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [],
      }),
    );

  await makeRequest();
  const firstSessionId = captured[0].headers['x-opencode-session'];

  await makeRequest();
  expect(
    captured[1].headers['x-opencode-session'],
    'session ID should be stable across requests in the same session',
  ).toBe(firstSessionId);
});

it('opencode session header prefers fallback session ID over traffic context session ID', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(
    captured,
    successResponse,
    'openai-compatible',
    'https://opencode.ai/v1',
    {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      security: () => {},
      setCorrelationId: () => {},
      getCorrelationId: () => undefined,
      clearCorrelationId: () => {},
    },
    {
      getContext: () => ({
        sessionId: 'conversation-session-123',
        sessionStartedAt: '2026-05-25T12:00:00.000Z',
      }),
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
    },
  );
  const model = await provider.getStreamedModel('provider-model');

  await runUnderTrace(() =>
    collectCompletion(model, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
    }),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].headers['x-opencode-session']).toBeTruthy();
  expect(captured[0].headers['x-opencode-session']).not.toBe('conversation-session-123');
  expect(captured[0].headers['x-opencode-session']).toMatch(/^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
});

it('non-opencode.ai baseUrl does not add opencode headers or body fields', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'openai-compatible', 'https://other-provider.com/v1');
  const model = await provider.getStreamedModel('provider-model');

  await runUnderTrace(() =>
    collectCompletion(model, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
    }),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].headers['x-opencode-session']).toBeFalsy();
});

it('opencode.ai detection is case-insensitive', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'openai-compatible', 'https://OPENCODE.AI/v1');
  const model = await provider.getStreamedModel('provider-model');

  await runUnderTrace(() =>
    collectCompletion(model, {
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
    }),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].headers['x-opencode-session']).toBeTruthy();
});

it('opencode provider type uses default base URL and falls back to OPENCODE_API_KEY', async () => {
  const captured: CapturedRequest[] = [];
  process.env.OPENCODE_API_KEY = 'env-opencode-key';
  try {
    const provider = createCustomProviderModelProvider(
      {
        name: 'opencode-test',
        type: 'opencode',
        // baseUrl and apiKey omitted
      },
      {
        defaultModel: 'provider-model',
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const headers: Record<string, string> = {};
          const rawHeaders = init?.headers as any;
          if (rawHeaders) {
            if (typeof rawHeaders.forEach === 'function') {
              rawHeaders.forEach((v: string, k: string) => {
                headers[k.toLowerCase()] = String(v);
              });
            } else {
              for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
                headers[k.toLowerCase()] = String(v);
              }
            }
          }
          const rawBody = typeof init?.body === 'string' ? init.body : '';
          captured.push({
            url: typeof input === 'string' ? input : (input as URL).toString(),
            body: rawBody ? JSON.parse(rawBody) : null,
            headers,
          });
          return streamedSuccessResponse();
        }) as typeof fetch,
      },
    );

    const model = provider.getStreamedModel('provider-model');

    await runUnderTrace(() =>
      collectCompletion(model, {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [],
      }),
    );

    expect(captured.length).toBe(1);
    expect(captured[0].url).toMatch(/^https:\/\/opencode\.ai\/v1\/chat\/completions(\?|$)/);
    expect(captured[0].headers.authorization).toBe('Bearer env-opencode-key');
    expect(captured[0].headers['x-opencode-session']).toBeTruthy();
  } finally {
    delete process.env.OPENCODE_API_KEY;
  }
});

it('opencode qwen models use Anthropic messages transport with session header', async () => {
  const captured: CapturedRequest[] = [];
  process.env.OPENCODE_API_KEY = 'env-opencode-key';
  try {
    const provider = createCustomProviderModelProvider(
      {
        name: 'opencode-test',
        type: 'opencode',
      },
      {
        defaultModel: 'qwen3-coder',
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const headers: Record<string, string> = {};
          const rawHeaders = init?.headers as any;
          if (rawHeaders) {
            if (typeof rawHeaders.forEach === 'function') {
              rawHeaders.forEach((v: string, k: string) => {
                headers[k.toLowerCase()] = String(v);
              });
            } else {
              for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
                headers[k.toLowerCase()] = String(v);
              }
            }
          }
          const rawBody = typeof init?.body === 'string' ? init.body : '';
          captured.push({
            url: typeof input === 'string' ? input : (input as URL).toString(),
            body: rawBody ? JSON.parse(rawBody) : null,
            headers,
          });
          const body = new ReadableStream({
            start(controller) {
              const events = [
                [
                  'message_start',
                  {
                    type: 'message_start',
                    message: {
                      id: 'msg_test',
                      type: 'message',
                      role: 'assistant',
                      usage: { input_tokens: 1 },
                    },
                  },
                ],
                [
                  'content_block_start',
                  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                ],
                [
                  'content_block_delta',
                  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
                ],
                ['content_block_stop', { type: 'content_block_stop', index: 0 }],
                [
                  'message_delta',
                  {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn' },
                    usage: { input_tokens: 1, output_tokens: 1 },
                  },
                ],
                ['message_stop', { type: 'message_stop' }],
              ];
              controller.enqueue(
                new TextEncoder().encode(
                  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
                ),
              );
              controller.close();
            },
          });
          return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }) as typeof fetch,
      },
    );

    const model = provider.getStreamedModel('qwen3-coder');

    await runUnderTrace(() =>
      collectCompletion(model, {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [],
        reasoning: { effort: 'high' },
      }),
    );

    expect(captured.length).toBe(1);
    expect(captured[0].url).toMatch(/^https:\/\/opencode\.ai\/v1\/messages(\?|$)/);
    expect(captured[0].headers['x-api-key']).toBe('env-opencode-key');
    expect(captured[0].headers['x-opencode-session']).toBeTruthy();
    expect(captured[0].body.model).toBe('qwen3-coder');
    expect(captured[0].body.reasoning_effort).toBe(undefined);
    expect(captured[0].body.messages[0].content[0].cache_control).toBeTruthy();
  } finally {
    delete process.env.OPENCODE_API_KEY;
  }
});

it('opencode provider type keeps the fallback session ID stable across turns', async () => {
  const captured: CapturedRequest[] = [];
  process.env.OPENCODE_API_KEY = 'env-opencode-key';
  try {
    const provider = createCustomProviderModelProvider(
      {
        name: 'opencode-test',
        type: 'opencode',
      },
      {
        defaultModel: 'provider-model',
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const headers: Record<string, string> = {};
          const rawHeaders = init?.headers as any;
          if (rawHeaders) {
            if (typeof rawHeaders.forEach === 'function') {
              rawHeaders.forEach((v: string, k: string) => {
                headers[k.toLowerCase()] = String(v);
              });
            } else {
              for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
                headers[k.toLowerCase()] = String(v);
              }
            }
          }
          const rawBody = typeof init?.body === 'string' ? init.body : '';
          captured.push({
            url: typeof input === 'string' ? input : (input as URL).toString(),
            body: rawBody ? JSON.parse(rawBody) : null,
            headers,
          });
          return streamedSuccessResponse();
        }) as typeof fetch,
      },
    );

    const runTurn = async () => {
      const model = provider.getStreamedModel('provider-model');
      return runUnderTrace(() =>
        collectCompletion(model, {
          input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          tools: [],
        }),
      );
    };

    await runTurn();
    const firstSessionId = captured[0].headers['x-opencode-session'];

    await runTurn();

    expect(captured.length).toBe(2);
    expect(captured[1].headers['x-opencode-session']).toBe(firstSessionId);
  } finally {
    delete process.env.OPENCODE_API_KEY;
  }
});

it('recreated opencode provider instances reuse the active conversation session and isolate other sessions', async () => {
  const captured: CapturedRequest[] = [];
  let activeSessionId = 'conversation-a';
  const sessionContextService = {
    getContext: () => ({
      sessionId: activeSessionId,
      sessionStartedAt: '2026-05-25T12:00:00.000Z',
    }),
    runWithContext: <T>(_context: any, fn: () => T) => fn(),
  };

  const runTurn = async () => {
    const provider = buildProvider(
      captured,
      () => streamedSuccessResponse(),
      'opencode',
      'https://opencode.ai/v1',
      undefined,
      sessionContextService,
    );
    const model = provider.getStreamedModel('provider-model');
    await runUnderTrace(() =>
      collectCompletion(model, {
        input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [],
      }),
    );
  };

  await runTurn();
  await runTurn();
  expect(captured[1]?.headers['x-opencode-session']).toBe(captured[0]?.headers['x-opencode-session']);

  activeSessionId = 'conversation-b';
  await runTurn();
  expect(captured[2]?.headers['x-opencode-session']).not.toBe(captured[0]?.headers['x-opencode-session']);
});

it('lazy opencode provider returns an application-owned streamed model', async () => {
  const deps: ProviderDeps = {
    settingsService: {
      get: (key: string) => {
        if (key === 'providers') return [{ name: 'opencode-lazy-test', type: 'opencode' }];
        if (key === 'agent.model') return 'provider-model';
        return undefined;
      },
      getDynamic: (key: string) => {
        if (key === 'providers') return [{ name: 'opencode-lazy-test', type: 'opencode' }];
        return undefined;
      },
    } as any,
    loggingService: {
      debug: () => {},
      error: () => {},
      getCorrelationId: () => undefined,
    } as any,
    sessionContextService: {
      getContext: () => null,
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
    } as any,
  };

  const definition = createLazyProviderDefinition({ name: 'opencode-lazy-test', type: 'opencode' });
  const model = await definition.createStreamedModel!('provider-model', deps);
  expect(model).toHaveProperty('stream');
});

it('lazy provider definition preserves configured label', () => {
  const definition = createLazyProviderDefinition({
    name: 'lazy-provider-id',
    label: 'Lazy Provider Label',
    type: 'openai-compatible',
  });

  expect(definition.label).toBe('Lazy Provider Label');
});

it('opencode provider type returns a fresh application-owned streamed model', async () => {
  const provider = createCustomProviderModelProvider(
    {
      name: 'opencode-test',
      type: 'opencode',
    },
    {
      defaultModel: 'provider-model',
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: 'test',
            object: 'chat.completion',
            created: 1,
            model: 'provider-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    },
  );

  const model = provider.getStreamedModel('provider-model');
  expect(model).toHaveProperty('stream');
});
