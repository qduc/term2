import test from 'ava';
import { setTracingDisabled, withTrace } from '@openai/agents-core';
import {
  createCustomProviderModelProvider,
  createOpenAICompatibleProviderDefinition,
} from './openai-compatible.provider.js';
import type { ProviderDeps } from './registry.js';

setTracingDisabled(true);

const runUnderTrace = <T>(fn: () => Promise<T>): Promise<T> => withTrace('openai-compatible-provider-test', fn);

type CapturedRequest = {
  url: string;
  body: any;
  headers: Record<string, string>;
};

function buildProvider(captured: CapturedRequest[], response: any, providerType = 'openai-compatible') {
  return createCustomProviderModelProvider(
    {
      name: 'provider-test',
      type: providerType,
      baseUrl: 'https://provider.test/v1',
      apiKey: 'provider-key',
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
          url: typeof input === 'string' ? input : (input as URL).toString?.() ?? String(input),
          body: rawBody ? JSON.parse(rawBody) : null,
          headers,
        });
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

test('runtime openai-compatible createRunner returns a runner', (t) => {
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

  t.truthy(runner);
});

test('providerData fields are forwarded into the chat-completions request body root', async (t) => {
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

  t.is(captured.length, 1);
  const body = captured[0].body;
  t.is(body.service_tier, 'flex');
  t.is(body.custom_vendor_flag, 'on');
});

test('modelSettings.reasoning.effort is forwarded as reasoning_effort', async (t) => {
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

  t.is(captured.length, 1);
  t.is(captured[0].body.reasoning_effort, 'high');
});

test('assistant reasoning_content is passed back with the following tool call', async (t) => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getModel('provider-model');

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

  t.is(captured.length, 1);
  t.deepEqual(captured[0].body.messages.slice(1, 4), [
    {
      role: 'assistant',
      content: null,
      reasoning: 'Need to use the shell for the exact time.',
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
    { role: 'user', content: 'thanks' },
  ]);
});

test('llama.cpp maps high reasoning effort to chat template kwargs', async (t) => {
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

  t.is(captured.length, 1);
  t.is(captured[0].body.reasoning_effort, undefined);
  t.deepEqual(captured[0].body.chat_template_kwargs, {
    reasoning_effort: 'high',
    enable_thinking: true,
    thinking_mode: 'high',
    reasoning_budget: 8192,
  });
});

test('llama.cpp disables thinking for none reasoning effort', async (t) => {
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

  t.is(captured.length, 1);
  t.is(captured[0].body.reasoning_effort, undefined);
  t.deepEqual(captured[0].body.chat_template_kwargs, {
    reasoning_effort: 'low',
    enable_thinking: false,
    thinking_mode: 'disabled',
    reasoning_budget: 0,
  });
});

test('llama.cpp maps xhigh to high template mode with xhigh budget', async (t) => {
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

  t.is(captured.length, 1);
  t.deepEqual(captured[0].body.chat_template_kwargs, {
    reasoning_effort: 'high',
    enable_thinking: true,
    thinking_mode: 'high',
    reasoning_budget: 16384,
  });
});

test('llama.cpp leaves reasoning controls unset when effort is default', async (t) => {
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

  t.is(captured.length, 1);
  t.is(captured[0].body.reasoning_effort, undefined);
  t.is(captured[0].body.chat_template_kwargs, undefined);
});

test('outgoing request hits the configured /chat/completions endpoint with bearer auth', async (t) => {
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

  t.is(captured.length, 1);
  t.regex(captured[0].url, /\/chat\/completions(\?|$)/);
  t.is(captured[0].headers.authorization, 'Bearer provider-key');
  t.is(captured[0].body.model, 'provider-model');
});
