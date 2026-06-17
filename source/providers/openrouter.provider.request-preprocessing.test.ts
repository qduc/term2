import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { composeFetch } from './fetch/compose.js';
import { openRouterPreprocessingMiddleware } from './openrouter.provider.js';

it('openRouterPreprocessingMiddleware strips unsigned reasoning.text for gemini/anthropic formats', async () => {
  let capturedBody: any;
  const baseFetch: typeof fetch = async (_input, init) => {
    capturedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const composed = composeFetch(baseFetch, [openRouterPreprocessingMiddleware]);

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

  await composed('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  expect(capturedBody.messages[0].reasoning_details).toEqual([
    { type: 'reasoning.text', format: 'google-gemini-v1', text: 'keep-me', signature: 'sig' },
    { type: 'reasoning.text', format: 'other-format', text: 'keep-format' },
    { type: 'reasoning.encrypted', format: 'google-gemini-v1', data: 'abc' },
  ]);
});

it('openRouterPreprocessingMiddleware passes through non-JSON bodies', async () => {
  let called = false;
  const baseFetch: typeof fetch = async (_input, init) => {
    called = true;
    expect(init?.body).toBe('not-json');
    return new Response('{}', { status: 200 });
  };

  const composed = composeFetch(baseFetch, [openRouterPreprocessingMiddleware]);

  await composed('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    body: 'not-json',
  });

  expect(called).toBe(true);
});
