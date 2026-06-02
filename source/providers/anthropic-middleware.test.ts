import test from 'ava';
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

test('adds x-opencode-session header for opencode provider', async (t) => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('opencode', 'https://opencode.ai/v1');
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  await composed('https://opencode.ai/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hello' }] }),
  });

  t.is(captured.length, 1);
  t.truthy(captured[0].headers['x-opencode-session']);
  t.regex(captured[0].headers['x-opencode-session'], /^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
  t.is(captured[0].headers['x-opencode-session'].length, 30);
});

test('does not add x-opencode-session for non-opencode provider', async (t) => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('anthropic', 'https://api.anthropic.com');
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  await composed('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hello' }] }),
  });

  t.is(captured.length, 1);
  t.falsy(captured[0].headers['x-opencode-session']);
});

test('opencode detection is case-insensitive', async (t) => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('anthropic', 'https://OPENCODE.AI/v1');
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  await composed('https://OPENCODE.AI/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hello' }] }),
  });

  t.is(captured.length, 1);
  t.truthy(captured[0].headers['x-opencode-session']);
});

test('session ID is stable across requests in same session', async (t) => {
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

  t.is(captured[1].headers['x-opencode-session'], firstSessionId);
});

test('opencode type derived from providerType alone', async (t) => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('opencode');
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  await composed('https://any-host/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hello' }] }),
  });

  t.is(captured.length, 1);
  t.truthy(captured[0].headers['x-opencode-session']);
});

test('session ID uses fallbackSessionIdOverride when provided', async (t) => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware(
    'opencode',
    'https://opencode.ai/v1',
    undefined,
    'ses_123456789012abcABC0abcABC0ab',
  );
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  await composed('https://opencode.ai/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hello' }] }),
  });

  t.is(captured[0].headers['x-opencode-session'], 'ses_123456789012abcABC0abcABC0ab');
});

test('does not modify the request body', async (t) => {
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

  t.deepEqual(captured[0].body, bodyPayload);
});

test('preserves existing headers when adding opencode session header', async (t) => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('opencode');
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  await composed('https://opencode.ai/v1/messages', {
    method: 'POST',
    headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-test' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hello' }] }),
  });

  t.is(captured[0].headers['anthropic-version'], '2023-06-01');
  t.is(captured[0].headers['x-api-key'], 'sk-test');
  t.truthy(captured[0].headers['x-opencode-session']);
});

test('passes through non-JSON bodies unchanged', async (t) => {
  const captured: CapturedRequest[] = [];
  const middleware = createAnthropicMiddleware('opencode', 'https://opencode.ai/v1');
  const composed = composeFetch(makeCapturingFetch(captured), [middleware]);

  await composed('https://opencode.ai/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array([1, 2, 3]),
  });

  t.is(captured.length, 1);
  t.true(captured[0].body instanceof Uint8Array);
  t.truthy(captured[0].headers['x-opencode-session'], 'opencode header should still be added');
});
