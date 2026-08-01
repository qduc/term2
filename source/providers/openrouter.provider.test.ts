import { it, expect } from 'vitest';
import { openRouterPreprocessingMiddleware } from './openrouter.provider.js';
import type { FetchContext } from './fetch/compose.js';

async function runMiddleware(body: Record<string, unknown>, model?: string): Promise<any> {
  let capturedInit: RequestInit | undefined;
  const next = async (ctx: FetchContext): Promise<Response> => {
    capturedInit = ctx.init;
    return new Response('{}');
  };
  await openRouterPreprocessingMiddleware(
    {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      init: { method: 'POST', body: JSON.stringify({ model, ...body }) },
    },
    next,
  );
  return JSON.parse(capturedInit!.body as string);
}

it('strips unsigned reasoning.text details requiring a signature for anthropic-claude-v1', async () => {
  const body = await runMiddleware({
    messages: [
      {
        role: 'assistant',
        reasoning_details: [
          { type: 'reasoning.text', format: 'anthropic-claude-v1', text: 'unsigned' },
          { type: 'reasoning.text', format: 'anthropic-claude-v1', text: 'signed', signature: 'sig' },
          { type: 'reasoning.summary', format: 'anthropic-claude-v1' },
        ],
      },
    ],
  });

  expect(body.messages[0].reasoning_details).toEqual([
    { type: 'reasoning.text', format: 'anthropic-claude-v1', text: 'signed', signature: 'sig' },
    { type: 'reasoning.summary', format: 'anthropic-claude-v1' },
  ]);
});

it('adds cache_control to the last user message for an anthropic-routed model', async () => {
  const body = await runMiddleware(
    {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        { role: 'user', content: 'second' },
      ],
    },
    'anthropic/claude-sonnet',
  );

  expect(body.messages).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'user', content: [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }] },
  ]);
});

it('leaves messages untouched for models outside the cache-control allowlist', async () => {
  const body = await runMiddleware(
    {
      messages: [{ role: 'user', content: 'hello' }],
    },
    'openai/gpt-5',
  );

  expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
});

it('passes the request through unmodified when the body is not JSON', async () => {
  let capturedInit: RequestInit | undefined;
  const next = async (ctx: FetchContext): Promise<Response> => {
    capturedInit = ctx.init;
    return new Response('{}');
  };
  await openRouterPreprocessingMiddleware(
    { url: 'https://openrouter.ai/api/v1/chat/completions', init: { method: 'POST', body: 'not-json' } },
    next,
  );
  expect(capturedInit!.body).toBe('not-json');
});
