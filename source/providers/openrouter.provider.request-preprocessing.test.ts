import test from 'ava';
import { createOpenRouterRequestPreprocessingFetch } from './openrouter.provider.js';

test('createOpenRouterRequestPreprocessingFetch strips unsigned reasoning.text for gemini/anthropic formats', async (t) => {
  let capturedBody: any;
  const wrapped = createOpenRouterRequestPreprocessingFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const body = {
    model: 'openrouter/auto',
    messages: [
      {
        role: 'assistant',
        content: 'hello',
        reasoning_details: [
          { type: 'reasoning.text', format: 'google-gemini-v1', text: 'drop-me' },
          { type: 'reasoning.text', format: 'google-gemini-v1', text: 'keep-me', signature: 'sig' },
          { type: 'reasoning.text', format: 'anthropic-claude-v1', text: 'drop-me-too' },
          { type: 'reasoning.text', format: 'other-format', text: 'keep-format' },
          { type: 'reasoning.encrypted', format: 'google-gemini-v1', data: 'abc' },
        ],
      },
    ],
  };

  await wrapped('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  t.deepEqual(capturedBody.messages[0].reasoning_details, [
    { type: 'reasoning.text', format: 'google-gemini-v1', text: 'keep-me', signature: 'sig' },
    { type: 'reasoning.text', format: 'other-format', text: 'keep-format' },
    { type: 'reasoning.encrypted', format: 'google-gemini-v1', data: 'abc' },
  ]);
});

test('createOpenRouterRequestPreprocessingFetch passes through non-JSON bodies', async (t) => {
  let called = false;
  const wrapped = createOpenRouterRequestPreprocessingFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
    called = true;
    t.is(init?.body, 'not-json');
    return new Response('{}', { status: 200 });
  });

  await wrapped('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    body: 'not-json',
  });

  t.true(called);
});
