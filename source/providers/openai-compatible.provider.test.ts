import { it, expect } from 'vitest';
import { setTracingDisabled, withTrace } from '@openai/agents-core';
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
        captured.push({
          url: typeof input === 'string' ? input : (input as URL).toString?.() ?? String(input),
          body: rawBody ? JSON.parse(rawBody) : null,
          headers,
        });
        if (response instanceof Response) {
          return response;
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

const baseRequest = {
  tools: [],
  handoffs: [],
  outputType: 'text' as const,
  tracing: false as const,
};

it('runtime openai-compatible createRunner returns a runner', () => {
  const provider = createOpenAICompatibleProviderDefinition({
    name: 'local-test',
    baseUrl: 'http://localhost:11434',
  });

  const deps: ProviderDeps = {
    settingsService: {
      get: <T = any>(key: string) => {
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
        return values[key] as T;
      },
      set: () => {},
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

  const runner = provider.createRunner!(deps);

  expect(runner).toBeTruthy();
});

it('providerData fields are forwarded into the chat-completions request body root', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getModel('provider-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: {
        providerData: {
          service_tier: 'flex',
          custom_vendor_flag: 'on',
        },
      },
    } as any),
  );

  expect(captured.length).toBe(1);
  const body = captured[0].body;
  expect(body.service_tier).toBe('flex');
  expect(body.custom_vendor_flag).toBe('on');
});

it('modelSettings.reasoning.effort is forwarded as reasoning_effort', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getModel('provider-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: { reasoning: { effort: 'high', summary: 'auto' } },
    } as any),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].body.reasoning_effort).toBe('high');
});

it('assistant reasoning_content is passed back with the following tool call', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getModel('claude-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [
        { role: 'user', type: 'message', content: 'what time is it?' },
        {
          type: 'reasoning',
          rawContent: [{ type: 'reasoning_text', text: 'Need to use the shell for the exact time.' }],
        },
        {
          type: 'function_call',
          callId: 'shell:0',
          name: 'shell',
          arguments: '{"command":"date"}',
        },
        {
          type: 'function_call_result',
          callId: 'shell:0',
          output: 'Tue May 12 18:40:41 +07 2026',
        },
        { role: 'user', type: 'message', content: 'thanks' },
      ] as any,
      modelSettings: {},
    } as any),
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
      content: [{ type: 'text', text: 'Tue May 12 18:40:41 +07 2026', cache_control: { type: 'ephemeral' } }],
      tool_call_id: 'shell:0',
    },
    { role: 'user', content: [{ type: 'text', text: 'thanks', cache_control: { type: 'ephemeral' } }] },
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
  const model = await provider.getModel('provider-model');

  const result = await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: {},
    } as any),
  );

  expect(result.output[0]).toEqual({
    type: 'reasoning',
    content: [],
    rawContent: [{ type: 'reasoning_text', text: 'Need to inspect the project first.' }],
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
  const model = await provider.getModel('provider-model');

  const events: any[] = [];
  for await (const event of model.getStreamedResponse({
    ...baseRequest,
    input: [{ role: 'user', content: 'hello' }] as any,
    modelSettings: {},
  } as any)) {
    events.push(event);
  }

  const finalEvent = events.find((event: any) => event.type === 'response_done') as any;
  expect(finalEvent.response.output[0]).toEqual({
    type: 'reasoning',
    content: [],
    rawContent: [{ type: 'reasoning_text', text: 'Need to stream reasoning.' }],
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
  const model = await provider.getModel('provider-model');

  const events: any[] = [];
  for await (const event of model.getStreamedResponse({
    ...baseRequest,
    input: [{ role: 'user', content: 'hello' }] as any,
    modelSettings: {},
  } as any)) {
    events.push(event);
  }

  const finalEvent = events.find((event: any) => event.type === 'response_done') as any;
  expect(finalEvent.response.output[0].type).toBe('message');
  expect(finalEvent.response.output[0].content[0].type).toBe('output_text');
  expect(finalEvent.response.output[0].content[0].text).toBe('Hello! How can I help you today?');
});

it('reasoning field is stripped and preserved only as reasoning_content in outgoing requests', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getModel('provider-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [
        { role: 'user', type: 'message', content: 'hello' },
        {
          type: 'reasoning',
          rawContent: [{ type: 'reasoning_text', text: 'I should run date.' }],
        },
        {
          type: 'function_call',
          callId: 'shell:0',
          name: 'shell',
          arguments: '{"command":"date"}',
        },
        {
          type: 'function_call_result',
          callId: 'shell:0',
          output: 'Mon Jan 01 00:00:00 UTC 2024',
        },
        { role: 'user', type: 'message', content: 'thanks' },
      ] as any,
      modelSettings: {},
    } as any),
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
  const model = await provider.getModel('provider-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [
        { role: 'user', type: 'message', content: 'hello' },
        {
          type: 'function_call',
          callId: 'shell:0',
          name: 'shell',
          arguments: '{"command":"date"}',
          providerData: { index: 0 },
        },
        {
          type: 'function_call_result',
          callId: 'shell:0',
          output: 'Mon Jan 01 00:00:00 UTC 2024',
        },
        { role: 'user', type: 'message', content: 'thanks' },
      ] as any,
      modelSettings: {},
    } as any),
  );

  expect(captured.length).toBe(1);
  for (const message of captured[0].body.messages) {
    expect('index' in message).toBe(false);
  }
});

it('llama.cpp maps high reasoning effort to chat template kwargs', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'llama.cpp');
  const model = await provider.getModel('provider-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: { reasoning: { effort: 'high', summary: 'auto' } },
    } as any),
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
  const model = await provider.getModel('provider-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: { reasoning: { effort: 'none', summary: 'auto' } },
    } as any),
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
  const model = await provider.getModel('provider-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: { reasoning: { effort: 'xhigh', summary: 'auto' } },
    } as any),
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
  const model = await provider.getModel('provider-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: {},
    } as any),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].body.reasoning_effort).toBe(undefined);
  expect(captured[0].body.chat_template_kwargs).toBe(undefined);
});

it('outgoing request hits the configured /chat/completions endpoint with bearer auth', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getModel('provider-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: {},
    } as any),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].url).toMatch(/\/chat\/completions(\?|$)/);
  expect(captured[0].headers.authorization).toBe('Bearer provider-key');
  expect(captured[0].body.model).toBe('provider-model');
});

it('opencode.ai baseUrl adds x-opencode-session header', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'openai-compatible', 'https://opencode.ai/v1');
  const model = await provider.getModel('provider-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: {},
    } as any),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].headers['x-opencode-session']).toBeTruthy();
  expect(captured[0].headers['x-opencode-session']).toMatch(/^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
  expect(captured[0].headers['x-opencode-session'].length, 'session ID should be exactly 30 characters').toBe(30);
});

it('opencode session ID is stable across requests within a session', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'openai-compatible', 'https://opencode.ai/v1');
  const model = await provider.getModel('provider-model');

  const makeRequest = () =>
    runUnderTrace(() =>
      model.getResponse({
        ...baseRequest,
        input: [{ role: 'user', content: 'hello' }] as any,
        modelSettings: {},
      } as any),
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
  const model = await provider.getModel('provider-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: {},
    } as any),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].headers['x-opencode-session']).toBeTruthy();
  expect(captured[0].headers['x-opencode-session']).not.toBe('conversation-session-123');
  expect(captured[0].headers['x-opencode-session']).toMatch(/^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
});

it('non-opencode.ai baseUrl does not add opencode headers or body fields', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'openai-compatible', 'https://other-provider.com/v1');
  const model = await provider.getModel('provider-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: {},
    } as any),
  );

  expect(captured.length).toBe(1);
  expect(captured[0].headers['x-opencode-session']).toBeFalsy();
});

it('opencode.ai detection is case-insensitive', async () => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'openai-compatible', 'https://OPENCODE.AI/v1');
  const model = await provider.getModel('provider-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: {},
    } as any),
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
          return new Response(JSON.stringify(successResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }) as typeof fetch,
      },
    );

    const model = await provider.getModel('provider-model');

    await runUnderTrace(() =>
      model.getResponse({
        ...baseRequest,
        input: [{ role: 'user', content: 'hello' }] as any,
        modelSettings: {},
      } as any),
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
          return new Response(
            JSON.stringify({
              id: 'msg_test',
              type: 'message',
              role: 'assistant',
              model: 'qwen3-coder',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }) as typeof fetch,
      },
    );

    const model = await provider.getModel('qwen3-coder');

    await runUnderTrace(() =>
      model.getResponse({
        ...baseRequest,
        input: [{ role: 'user', content: 'hello' }] as any,
        modelSettings: { reasoning: { effort: 'high' } },
      } as any),
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
          return new Response(JSON.stringify(successResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }) as typeof fetch,
      },
    );

    const runTurn = async () => {
      const model = await provider.getModel('provider-model');
      return runUnderTrace(() =>
        model.getResponse({
          ...baseRequest,
          input: [{ role: 'user', content: 'hello' }] as any,
          modelSettings: {},
        } as any),
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

it('lazy opencode provider reuses the same model provider instance across getModel calls (regression: was recreated per turn, resetting session ID)', async () => {
  const deps: ProviderDeps = {
    settingsService: {
      get: (key: string) => {
        if (key === 'providers') return [{ name: 'opencode-lazy-test', type: 'opencode' }];
        if (key === 'agent.model') return 'provider-model';
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
  const runner = definition.createRunner!(deps)!;
  const modelProvider = (runner as any).config?.modelProvider;
  expect(modelProvider).toBeTruthy();

  // Wrap getModel to track how many distinct underlying provider instances are created.
  // The lazy provider wraps a cached inner provider; the model instances it returns are
  // cached by the inner OpencodeAnthropicFormatProvider.  If the inner provider is
  // recreated on each call, different model instances will be returned for the same name.
  const model1 = await modelProvider.getModel('provider-model');
  const model2 = await modelProvider.getModel('provider-model');

  expect(
    model1,
    'same model instance must be returned on repeated getModel calls — a new instance means a new session ID',
  ).toBe(model2);
});

it('lazy provider definition preserves configured label', () => {
  const definition = createLazyProviderDefinition({
    name: 'lazy-provider-id',
    label: 'Lazy Provider Label',
    type: 'openai-compatible',
  });

  expect(definition.label).toBe('Lazy Provider Label');
});

it('opencode provider type caches model instances across getModel calls', async () => {
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

  const model1 = await provider.getModel('provider-model');
  const model2 = await provider.getModel('provider-model');
  expect(model1, 'getModel should return the same model instance for the same model name').toBe(model2);
});
