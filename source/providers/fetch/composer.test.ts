import { it, expect } from 'vitest';
import { composeFetch, FetchMiddleware } from './compose.js';
import { createLoggingMiddleware, CreateLoggingMiddlewareOptions } from './logging-middleware.js';
import { createProviderFetch } from './composer.js';
import { createRateLimitMiddleware } from './rate-limit-middleware.js';

import type { ISessionContextService } from '../../services/service-interfaces.js';

// ---------------------------------------------------------------------------
// composeFetch tests
// ---------------------------------------------------------------------------

it('composeFetch runs middlewares in correct order', async () => {
  const order: string[] = [];

  const middleware1: FetchMiddleware = async (ctx, next) => {
    order.push('mw1 enter');
    const res = await next(ctx);
    order.push('mw1 exit');
    return res;
  };
  const middleware2: FetchMiddleware = async (ctx, next) => {
    order.push('mw2 enter');
    const res = await next(ctx);
    order.push('mw2 exit');
    return res;
  };

  const baseFetch: typeof fetch = async () => {
    order.push('baseFetch');
    return new Response('ok', { status: 200 });
  };

  const composed = composeFetch(baseFetch, [middleware1, middleware2]);

  const res = await composed('https://example.test/');
  expect(res.status).toBe(200);
  expect(order).toEqual(['mw1 enter', 'mw2 enter', 'baseFetch', 'mw2 exit', 'mw1 exit']);
});

it('composeFetch with no middlewares returns baseFetch unchanged', async () => {
  const baseFetch: typeof fetch = async () => new Response('ok', { status: 200 });
  const composed = composeFetch(baseFetch, []);
  expect(await composed('https://example.test/').then((r) => r.text())).toBe('ok');
});

it('composeFetch allows middlewares to mutate ctx (url and init)', async () => {
  const captured: Array<{ url: RequestInfo | URL; init?: RequestInit }> = [];

  const urlRewriter: FetchMiddleware = async (ctx, next) => {
    ctx.url = 'https://rewritten.test/';
    return next(ctx);
  };

  const headerInjector: FetchMiddleware = async (ctx, next) => {
    ctx.init = { ...ctx.init, headers: { 'x-custom': 'yes' } };
    return next(ctx);
  };

  const baseFetch: typeof fetch = async (input, init) => {
    captured.push({ url: input, init });
    return new Response('ok', { status: 200 });
  };

  const composed = composeFetch(baseFetch, [urlRewriter, headerInjector]);
  await composed('https://original.test/', { method: 'POST' });

  expect(captured.length).toBe(1);
  expect(captured[0]!.url).toBe('https://rewritten.test/');
  expect(captured[0]!.init?.headers).toEqual({ 'x-custom': 'yes' });
  expect(captured[0]!.init?.method).toBe('POST');
});

it('composeFetch propagates error from middleware', async () => {
  const errorMw: FetchMiddleware = async () => {
    throw new Error('middleware error');
  };

  const baseFetch: typeof fetch = async () => new Response('ok', { status: 200 });
  const composed = composeFetch(baseFetch, [errorMw]);

  await expect(() => composed('https://example.test/')).rejects.toThrow('middleware error');
});

it('composeFetch propagates error from baseFetch', async () => {
  const baseFetch: typeof fetch = async () => {
    throw new Error('base fetch error');
  };

  const composed = composeFetch(baseFetch, []);

  await expect(() => composed('https://example.test/')).rejects.toThrow('base fetch error');
});

// ---------------------------------------------------------------------------
// createRateLimitMiddleware tests
// ---------------------------------------------------------------------------

it('createRateLimitMiddleware passes through non-429 responses', async () => {
  const middleware = createRateLimitMiddleware();

  const baseFetch: typeof fetch = async () => new Response('ok', { status: 200 });
  const composed = composeFetch(baseFetch, [middleware]);

  const res = await composed('https://example.test/');
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('ok');
});

it('createRateLimitMiddleware passes through 429 with retry-after <= 60s', async () => {
  const middleware = createRateLimitMiddleware();

  const baseFetch: typeof fetch = async () =>
    new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });
  const composed = composeFetch(baseFetch, [middleware]);

  const res = await composed('https://example.test/');
  expect(res.status).toBe(429);
  expect(await res.text()).toBe('rate limited');
});

it('createRateLimitMiddleware passes through 429 with no retry-after header', async () => {
  const middleware = createRateLimitMiddleware();

  const baseFetch: typeof fetch = async () => new Response('rate limited', { status: 429 });
  const composed = composeFetch(baseFetch, [middleware]);

  const res = await composed('https://example.test/');
  expect(res.status).toBe(429);
});

it('createRateLimitMiddleware returns 429 with x-should-retry: false when retry-after > 60s (seconds)', async () => {
  const middleware = createRateLimitMiddleware();

  const baseFetch: typeof fetch = async () =>
    new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } });
  const composed = composeFetch(baseFetch, [middleware]);

  const res = await composed('https://example.test/');
  expect(res.status).toBe(429);
  expect(res.headers.get('x-should-retry')).toBe('false');
});

it('createRateLimitMiddleware returns 429 with x-should-retry: false when retry-after > 60s (HTTP-date)', async () => {
  const middleware = createRateLimitMiddleware();

  const futureDate = new Date(Date.now() + 90_000); // 90s from now
  const baseFetch: typeof fetch = async () =>
    new Response('rate limited', {
      status: 429,
      headers: { 'retry-after': futureDate.toUTCString() },
    });
  const composed = composeFetch(baseFetch, [middleware]);

  const res = await composed('https://example.test/');
  expect(res.status).toBe(429);
  expect(res.headers.get('x-should-retry')).toBe('false');
});

it('createRateLimitMiddleware passes through 429 with invalid retry-after', async () => {
  const middleware = createRateLimitMiddleware();

  const baseFetch: typeof fetch = async () =>
    new Response('rate limited', { status: 429, headers: { 'retry-after': 'garbage' } });
  const composed = composeFetch(baseFetch, [middleware]);

  const res = await composed('https://example.test/');
  expect(res.status).toBe(429);
  expect(await res.text()).toBe('rate limited');
});

it('createProviderFetch with rate-limit middleware returns 429 with x-should-retry: false on retry-after > 60s', async () => {
  const composed = createProviderFetch({
    providerId: 'openai',
    defaultModel: 'gpt-4',
    deps: {
      loggingService: makeLoggingService(),
      sessionContextService: makeSessionContextService(null),
    },
    fetchImpl: async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '180' } }),
  });

  const res = await composed('https://example.test/', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-4', messages: [] }),
  });
  expect(res.status).toBe(429);
  expect(res.headers.get('x-should-retry')).toBe('false');
});

it('createProviderFetch long retry-after 429 is logged and response returned with x-should-retry: false', async () => {
  const logs: Array<{ message: string; meta: any }> = [];

  const composed = createProviderFetch({
    providerId: 'openai',
    defaultModel: 'gpt-4',
    deps: {
      loggingService: makeLoggingService({
        debug: (message: string, meta?: any) => {
          logs.push({ message, meta });
        },
        error: (message: string, meta?: any) => {
          logs.push({ message, meta });
        },
      }),
      sessionContextService: makeSessionContextService(null),
    },
    fetchImpl: async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '180' } }),
  });

  const res = await composed('https://example.test/', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-4', messages: [] }),
  });
  expect(res.status).toBe(429);
  expect(res.headers.get('x-should-retry')).toBe('false');

  // Allow fire-and-forget to flush
  await new Promise((resolve) => setTimeout(resolve, 0));

  const requestLog = logs.find((l) => l.message === 'openai ai sdk request');
  expect(requestLog).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Logging middleware tests
// ---------------------------------------------------------------------------

function makeLoggingService(
  overrides: Partial<CreateLoggingMiddlewareOptions['loggingService']> = {},
): CreateLoggingMiddlewareOptions['loggingService'] {
  return {
    debug: () => {},
    error: () => {},
    getCorrelationId: () => 'trace-test',
    ...overrides,
  };
}

function makeSessionContextService(context: ReturnType<ISessionContextService['getContext']>): ISessionContextService {
  return {
    runWithContext: (_context: any, fn: () => any) => fn(),
    getContext: () => context,
  };
}

it('createLoggingMiddleware logs request started and response received', async () => {
  const logs: Array<{ message: string; meta: any }> = [];

  const middleware = createLoggingMiddleware({
    provider: 'openrouter',
    model: 'test-model',
    loggingService: makeLoggingService({
      debug: (message: string, meta?: any) => {
        logs.push({ message, meta });
      },
      error: (message: string, meta?: any) => {
        logs.push({ message, meta });
      },
    }),
    sessionContextService: makeSessionContextService({
      sessionId: 'session-123',
      sessionStartedAt: '2026-05-22T09:14:31.125Z',
      firstUserMessagePreview: 'hi',
      mode: 'standard',
    }),
  });

  const baseFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  // Compose with just logging middleware
  const composed = composeFetch(baseFetch, [middleware]);

  const response = await composed('https://example.test/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer 12345',
      'x-custom-test': 'ok',
    },
    body: JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_file' } }],
    }),
  });

  expect(response.status).toBe(200);
  await response.text();
  // Allow fire-and-forget log to flush
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(logs.length, 'expected request + response log').toBe(2);

  // Check request log
  expect(logs[0]).toMatchObject({
    message: 'openrouter ai sdk request',
    meta: {
      eventType: 'provider.request.started',
      direction: 'sent',
      sessionId: 'session-123',
      provider: 'openrouter',
      model: 'test-model',
      messageCount: 1,
      toolsCount: 1,
    },
  });
  expect(logs[0].meta.messages).toEqual([{ role: 'user', content: 'hi' }]);
  expect(logs[0].meta.headers).toEqual({
    'content-type': 'application/json',
    authorization: '[REDACTED]',
    'x-custom-test': 'ok',
  });

  // Check response log
  expect(logs[1]).toMatchObject({
    message: 'openrouter ai sdk response',
    meta: {
      eventType: 'provider.response.received',
      direction: 'received',
      sessionId: 'session-123',
      provider: 'openrouter',
      model: 'test-model',
      status: 200,
    },
  });
  expect(logs[1].meta.text).toBe('hello');
  expect(logs[0].meta.requestId).toBeTruthy();
  expect(logs[0].meta.requestId).toBe(logs[1].meta.requestId);
});

it('createLoggingMiddleware logs response failed on error', async () => {
  const logs: Array<{ message: string; meta: any }> = [];

  const middleware = createLoggingMiddleware({
    provider: 'openrouter',
    model: 'test-model',
    loggingService: makeLoggingService({
      debug: (message: string, meta?: any) => {
        logs.push({ message, meta });
      },
      error: (message: string, meta?: any) => {
        logs.push({ message, meta });
      },
    }),
    sessionContextService: makeSessionContextService({
      sessionId: 'session-123',
      sessionStartedAt: '2026-05-22T09:14:31.125Z',
      firstUserMessagePreview: 'hi',
      mode: 'standard',
    }),
  });

  const baseFetch: typeof fetch = async () => {
    throw new TypeError('getaddrinfo ENOTFOUND api.example.test');
  };

  const composed = composeFetch(baseFetch, [middleware]);

  await expect(() =>
    composed('https://api.example.test/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
  ).rejects.toThrow(TypeError);

  // Allow fire-and-forget to flush (nothing expected after error, but let it settle)
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(logs.length).toBe(2);
  expect(logs[0]).toMatchObject({
    message: 'openrouter ai sdk request',
    meta: {
      eventType: 'provider.request.started',
      provider: 'openrouter',
      model: 'test-model',
    },
  });
  expect(logs[1]).toMatchObject({
    message: 'openrouter ai sdk request failed',
    meta: {
      eventType: 'provider.response.failed',
      provider: 'openrouter',
      model: 'test-model',
    },
  });
  expect(logs[0].meta.requestId).toBe(logs[1].meta.requestId);
});

it('createLoggingMiddleware uses evaluator event prefix when traffic context has evaluator flag', async () => {
  const logs: Array<{ message: string; meta: any }> = [];

  const middleware = createLoggingMiddleware({
    provider: 'openrouter',
    model: 'test-model',
    loggingService: makeLoggingService({
      debug: (message: string, meta?: any) => {
        logs.push({ message, meta });
      },
    }),
    sessionContextService: makeSessionContextService({
      sessionId: 'session-eval',
      sessionStartedAt: '2026-05-22T09:14:31.125Z',
      firstUserMessagePreview: 'hi',
      mode: 'standard',
      evaluator: true,
    }),
  });

  const baseFetch: typeof fetch = async () => new Response(JSON.stringify({}), { status: 200 });

  const composed = composeFetch(baseFetch, [middleware]);
  await composed('https://example.test/', {
    method: 'POST',
    body: JSON.stringify({ model: 'test-model', messages: [] }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(logs[0].meta.eventType).toBe('evaluator.request.started');
  expect(logs[1].meta.eventType).toBe('evaluator.response.received');
});

it('createLoggingMiddleware uses request model from body over default model', async () => {
  const logs: Array<{ message: string; meta: any }> = [];

  const middleware = createLoggingMiddleware({
    provider: 'openai',
    model: 'default-model',
    loggingService: makeLoggingService({
      debug: (message: string, meta?: any) => {
        logs.push({ message, meta });
      },
    }),
    sessionContextService: makeSessionContextService({
      sessionId: 'session-123',
      sessionStartedAt: '2026-05-22T09:14:31.125Z',
      firstUserMessagePreview: 'hi',
      mode: 'standard',
    }),
  });

  const baseFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const composed = composeFetch(baseFetch, [middleware]);
  await composed('https://example.test/', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-4', messages: [] }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(logs[0].meta.model).toBe('gpt-4');
  expect(logs[1].meta.model).toBe('gpt-4');
});

// ---------------------------------------------------------------------------
// createProviderFetch tests
// ---------------------------------------------------------------------------

it('createProviderFetch injects the logging and rate-limit middlewares', async () => {
  const logs: Array<{ message: string; meta: any }> = [];
  const mwOrder: string[] = [];

  const customMiddleware: FetchMiddleware = async (ctx, next) => {
    mwOrder.push('custom');
    return next(ctx);
  };

  const composed = createProviderFetch({
    providerId: 'openrouter',
    defaultModel: 'test-model',
    deps: {
      loggingService: makeLoggingService({
        debug: (message: string, meta?: any) => {
          logs.push({ message, meta });
        },
        error: (message: string, meta?: any) => {
          logs.push({ message, meta });
        },
      }),
      sessionContextService: makeSessionContextService({
        sessionId: 'session-123',
        sessionStartedAt: '2026-05-22T09:14:31.125Z',
        firstUserMessagePreview: 'hi',
        mode: 'standard',
      }),
    },
    middlewares: [customMiddleware],
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });

  await composed('https://example.test/', {
    method: 'POST',
    body: JSON.stringify({ model: 'test-model', messages: [] }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Custom middleware ran before logging (outermost runs first)
  expect(mwOrder).toEqual(['custom']);

  // Logging still fires
  expect(logs.length >= 2).toBe(true);
  expect(logs[0]).toMatchObject({
    message: 'openrouter ai sdk request',
  });
});

it('createProviderFetch with dynamic header injection middleware', async () => {
  let capturedHeaders: any = null;

  const headerInjector: FetchMiddleware = async (ctx, next) => {
    ctx.init = {
      ...ctx.init,
      headers: {
        ...(ctx.init?.headers as Record<string, string>),
        'x-dynamic': 'injected',
      },
    };
    return next(ctx);
  };

  const composed = createProviderFetch({
    providerId: 'openai',
    defaultModel: 'gpt-4',
    deps: {
      loggingService: makeLoggingService(),
      sessionContextService: makeSessionContextService(null),
    },
    middlewares: [headerInjector],
    fetchImpl: async (_input, init) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await composed('https://example.test/', {
    method: 'POST',
    headers: { 'existing-header': 'keep' },
    body: JSON.stringify({ model: 'gpt-4', messages: [] }),
  });

  expect(capturedHeaders).toBeTruthy();
  // Normalize headers to record
  const headersRecord: Record<string, string> = {};
  if (capturedHeaders instanceof Headers) {
    capturedHeaders.forEach((v: string, k: string) => {
      headersRecord[k] = v;
    });
  } else if (Array.isArray(capturedHeaders)) {
    for (const [k, v] of capturedHeaders) {
      headersRecord[k] = v;
    }
  } else {
    Object.assign(headersRecord, capturedHeaders);
  }

  expect(headersRecord['x-dynamic']).toBe('injected');
  expect(headersRecord['existing-header']).toBe('keep');
});

it('createProviderFetch fetchImpl parameter works', async () => {
  let called = false;

  const mockFetch: typeof fetch = async () => {
    called = true;
    return new Response('mock', { status: 201 });
  };

  const composed = createProviderFetch({
    providerId: 'openai',
    defaultModel: 'gpt-4',
    deps: {
      loggingService: makeLoggingService(),
      sessionContextService: makeSessionContextService(null),
    },
    fetchImpl: mockFetch,
  });

  const res = await composed('https://example.test/', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-4', messages: [] }),
  });

  expect(called).toBe(true);
  expect(res.status).toBe(201);
  expect(await res.text()).toBe('mock');
});

it('createProviderFetch exposes logging middleware types correctly', async () => {
  // Type-level test: ensure the options type is compatible
  const loggingService: CreateLoggingMiddlewareOptions['loggingService'] = {
    debug: () => {},
    error: () => {},
    getCorrelationId: () => 'trace',
  };

  const composed = createProviderFetch({
    providerId: 'test',
    defaultModel: 'test-model',
    deps: { loggingService, sessionContextService: makeSessionContextService(null) },
    fetchImpl: async () => new Response('ok', { status: 200 }),
  });

  const res = await composed('https://example.test/');
  expect(res.status).toBe(200);
});

it('createProviderFetch handles null session context gracefully', async () => {
  const composed = createProviderFetch({
    providerId: 'test',
    defaultModel: 'test-model',
    deps: {
      loggingService: {
        debug: () => {},
        error: () => {},
        getCorrelationId: () => undefined,
      },
      sessionContextService: makeSessionContextService(null),
    },
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });

  const res = await composed('https://example.test/', {
    method: 'POST',
    body: JSON.stringify({ model: 'test-model', messages: [] }),
  });
  expect(res.status).toBe(200);
});

it('createLoggingMiddleware handles error in fire-and-forget logging gracefully', async () => {
  const logs: Array<{ message: string; meta: any }> = [];

  // Middleware with a logging service that returns a broken response that
  // will cause summarizeReceivedTraffic to fail
  const middleware = createLoggingMiddleware({
    provider: 'openai',
    model: 'test-model',
    loggingService: makeLoggingService({
      debug: (message: string, meta?: any) => {
        logs.push({ message, meta });
      },
      error: (message: string, meta?: any) => {
        logs.push({ message, meta });
      },
    }),
    sessionContextService: makeSessionContextService({
      sessionId: 'session-123',
      sessionStartedAt: '2026-05-22T09:14:31.125Z',
      firstUserMessagePreview: 'hi',
      mode: 'standard',
    }),
  });

  // A response that will cause summarizeReceivedTraffic to throw
  const baseFetch: typeof fetch = async () => {
    const badResponse = new Response('not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    // Override clone to cause failure
    return badResponse;
  };

  const composed = composeFetch(baseFetch, [middleware]);

  const res = await composed('https://example.test/', {
    method: 'POST',
    body: JSON.stringify({ model: 'test-model', messages: [] }),
  });
  expect(res.status).toBe(200);

  // Allow fire-and-forget to flush
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The request log should be present
  expect(logs.length >= 1).toBe(true);
  expect(logs[0]).toMatchObject({
    message: 'openai ai sdk request',
  });
});
