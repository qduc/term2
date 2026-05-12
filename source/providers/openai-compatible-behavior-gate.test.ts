import test from 'ava';
import { setTracingDisabled, withTrace } from '@openai/agents-core';
import { createCustomProviderModelProvider } from './openai-compatible.provider.js';

setTracingDisabled(true);

const runUnderTrace = <T>(fn: () => Promise<T>): Promise<T> => withTrace('gate-test', fn);

type CapturedRequest = {
  url: string;
  body: any;
  headers: Record<string, string>;
};

function buildProvider(captured: CapturedRequest[], response: any, providerType = 'openai-compatible') {
  return createCustomProviderModelProvider(
    {
      name: 'gate',
      type: providerType,
      baseUrl: 'https://gate.test/v1',
      apiKey: 'gate-key',
    },
    {
      defaultModel: 'gate-model',
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
  id: 'chatcmpl-gate',
  object: 'chat.completion',
  created: 1,
  model: 'gate-model',
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

test('GATE: contiguous assistant reasoning + function_call collapse to one outgoing message with tool_calls', async (t) => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getModel('gate-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      systemInstructions: 'sys',
      input: [
        { role: 'user', content: 'what time is it?' },
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Need to call shell' }],
          rawContent: [{ type: 'reasoning_text', text: 'Need to call shell' }],
        },
        {
          type: 'function_call',
          callId: 'call-1',
          name: 'shell',
          arguments: '{"command":"date"}',
          status: 'completed',
        },
        {
          type: 'function_call_result',
          callId: 'call-1',
          name: 'shell',
          status: 'completed',
          output: { type: 'text', text: 'Mon Jan 1 12:00:00 UTC 2024' },
        },
      ] as any,
      modelSettings: {},
    } as any),
  );

  t.is(captured.length, 1, 'expected exactly one outgoing HTTP request');
  const messages = captured[0].body?.messages;
  t.true(Array.isArray(messages), 'request body must include a messages array');

  const assistantMessages = messages.filter((m: any) => m?.role === 'assistant');
  t.is(
    assistantMessages.length,
    1,
    'consecutive assistant reasoning + function_call must collapse into ONE assistant message (current behavior of withMergedAssistantReasoning)',
  );

  const assistant = assistantMessages[0];
  t.true(
    Array.isArray(assistant.tool_calls) && assistant.tool_calls.length === 1,
    'merged assistant message must carry the tool_calls entry',
  );
  t.is(assistant.tool_calls[0]?.function?.name, 'shell');

  const toolResultIdx = messages.findIndex((m: any) => m?.role === 'tool');
  const assistantIdx = messages.indexOf(assistant);
  t.true(assistantIdx >= 0 && toolResultIdx > assistantIdx, 'tool result must follow the merged assistant message');
});

test('GATE: providerData fields are forwarded into the chat-completions request body root', async (t) => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getModel('gate-model');

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
  t.is(
    body.service_tier,
    'flex',
    'modelSettings.providerData.service_tier must reach the outgoing request body (forwardProviderSettings + AI SDK providerOptions plumbing)',
  );
  t.is(
    body.custom_vendor_flag,
    'on',
    'arbitrary vendor-specific providerData fields must reach the outgoing request body',
  );
});

test('GATE: modelSettings.reasoning.effort is forwarded as reasoning_effort', async (t) => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getModel('gate-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: { reasoning: { effort: 'high', summary: 'auto' } },
    } as any),
  );

  t.is(captured.length, 1);
  t.is(
    captured[0].body.reasoning_effort,
    'high',
    'native chat-completions model merges modelSettings.reasoning.effort into the request body as reasoning_effort',
  );
});

test('GATE: llama.cpp maps high reasoning effort to chat template kwargs', async (t) => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'llama.cpp');
  const model = await provider.getModel('gate-model');

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

test('GATE: llama.cpp disables thinking for none reasoning effort', async (t) => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'llama.cpp');
  const model = await provider.getModel('gate-model');

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

test('GATE: llama.cpp maps xhigh to high template mode with xhigh budget', async (t) => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'llama.cpp');
  const model = await provider.getModel('gate-model');

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

test('GATE: llama.cpp leaves reasoning controls unset when effort is default', async (t) => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse, 'llama.cpp');
  const model = await provider.getModel('gate-model');

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

test('GATE: outgoing request hits the configured /chat/completions endpoint with bearer auth', async (t) => {
  const captured: CapturedRequest[] = [];
  const provider = buildProvider(captured, successResponse);
  const model = await provider.getModel('gate-model');

  await runUnderTrace(() =>
    model.getResponse({
      ...baseRequest,
      input: [{ role: 'user', content: 'hello' }] as any,
      modelSettings: {},
    } as any),
  );

  t.is(captured.length, 1);
  t.regex(captured[0].url, /\/chat\/completions(\?|$)/, 'must call /chat/completions');
  t.is(captured[0].headers.authorization, 'Bearer gate-key', 'must send bearer auth from apiKey');
  t.is(captured[0].body.model, 'gate-model', 'must send the resolved model id');
});
