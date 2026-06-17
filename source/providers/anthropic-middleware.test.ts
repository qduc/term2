import { it, expect } from 'vitest';
import { composeFetch } from './fetch/compose.js';
import { createAnthropicMiddleware } from './anthropic-middleware.js';

type CapturedRequest = {
  url: string;
  body: any;
  headers: Record<string, string>;
};

function makeCapturingFetch(captured: CapturedRequest[]): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
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
    captured.push({
      url: typeof input === 'string' ? input : String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null,
      headers,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
}

it('adds x-opencode-session header for opencode provider', async () => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('opencode', 'https://opencode.ai/v1');
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  await composed('https://opencode.ai/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hello' }] }),
  });

  expect(captured.length).toBe(1);
  expect(captured[0].headers['x-opencode-session']).toBeTruthy();
  expect(captured[0].headers['x-opencode-session']).toMatch(/^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
  expect(captured[0].headers['x-opencode-session'].length).toBe(30);
});

it('does not add x-opencode-session for non-opencode provider', async () => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('anthropic', 'https://api.anthropic.com');
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  await composed('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hello' }] }),
  });

  expect(captured.length).toBe(1);
  expect(captured[0].headers['x-opencode-session']).toBeFalsy();
});

it('opencode detection is case-insensitive', async () => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('anthropic', 'https://OPENCODE.AI/v1');
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  await composed('https://OPENCODE.AI/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hello' }] }),
  });

  expect(captured.length).toBe(1);
  expect(captured[0].headers['x-opencode-session']).toBeTruthy();
});

it('session ID is stable across requests in same session', async () => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('opencode', 'https://opencode.ai/v1');
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  const send = () =>
    composed('https://opencode.ai/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hello' }] }),
    });

  await send();
  const firstSessionId = captured[0].headers['x-opencode-session'];
  await send();

  expect(captured[1].headers['x-opencode-session']).toBe(firstSessionId);
});

it('opencode type derived from providerType alone', async () => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('opencode');
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  await composed('https://any-host/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hello' }] }),
  });

  expect(captured.length).toBe(1);
  expect(captured[0].headers['x-opencode-session']).toBeTruthy();
});

it('session ID uses fallbackSessionIdOverride when provided', async () => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('opencode', 'https://opencode.ai/v1', {
    fallbackSessionIdOverride: 'ses_123456789012abcABC0abcABC0ab',
  });
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  await composed('https://opencode.ai/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hello' }] }),
  });

  expect(captured[0].headers['x-opencode-session']).toBe('ses_123456789012abcABC0abcABC0ab');
});

it('does not modify the request body', async () => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('opencode', 'https://opencode.ai/v1');
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  const bodyPayload = {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    temperature: 0.7,
    system: 'You are a test bot.',
    messages: [{ role: 'user', content: 'Hello' }],
  };

  await composed('https://opencode.ai/v1/messages', {
    method: 'POST',
    body: JSON.stringify(bodyPayload),
  });

  expect(captured[0].body).toEqual(bodyPayload);
});

it('preserves existing headers when adding opencode session header', async () => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('opencode');
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  await composed('https://opencode.ai/v1/messages', {
    method: 'POST',
    headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-test' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hello' }] }),
  });

  expect(captured[0].headers['anthropic-version']).toBe('2023-06-01');
  expect(captured[0].headers['x-api-key']).toBe('sk-test');
  expect(captured[0].headers['x-opencode-session']).toBeTruthy();
});

it('passes through non-JSON bodies unchanged', async () => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('opencode', 'https://opencode.ai/v1');
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  await composed('https://opencode.ai/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array([1, 2, 3]),
  });

  expect(captured.length).toBe(1);
  expect(captured[0].body instanceof Uint8Array).toBe(true);
  expect(captured[0].headers['x-opencode-session']).toBeTruthy();
});
