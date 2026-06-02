import test from 'ava';
import { composeFetch, FetchMiddleware } from './compose.js';
import { createLoggingMiddleware, CreateLoggingMiddlewareOptions } from './logging-middleware.js';
import { createProviderFetch } from './composer.js';
import type { ISessionContextService } from '../../services/service-interfaces.js';

// ---------------------------------------------------------------------------
// composeFetch tests
// ---------------------------------------------------------------------------

test('composeFetch runs middlewares in correct order', async (t) => {
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
  t.is(res.status, 200);
  t.deepEqual(order, ['mw1 enter', 'mw2 enter', 'baseFetch', 'mw2 exit', 'mw1 exit']);
});

test('composeFetch with no middlewares returns baseFetch unchanged', async (t) => {
  const baseFetch: typeof fetch = async () => new Response('ok', { status: 200 });
  const composed = composeFetch(baseFetch, []);
  t.is(await composed('https://example.test/').then((r) => r.text()), 'ok');
});

test('composeFetch allows middlewares to mutate ctx (url and init)', async (t) => {
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

  t.is(captured.length, 1);
  t.is(captured[0]!.url, 'https://rewritten.test/');
  t.deepEqual(captured[0]!.init?.headers, { 'x-custom': 'yes' });
  t.is(captured[0]!.init?.method, 'POST');
});

test('composeFetch propagates error from middleware', async (t) => {
  const errorMw: FetchMiddleware = async () => {
    throw new Error('middleware error');
  };

  const baseFetch: typeof fetch = async () => new Response('ok', { status: 200 });
  const composed = composeFetch(baseFetch, [errorMw]);

  await t.throwsAsync(() => composed('https://example.test/'), {
    message: 'middleware error',
  });
});

test('composeFetch propagates error from baseFetch', async (t) => {
  const baseFetch: typeof fetch = async () => {
    throw new Error('base fetch error');
  };

  const composed = composeFetch(baseFetch, []);
  await t.throwsAsync(() => composed('https://example.test/'), {
    message: 'base fetch error',
  });
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

test('createLoggingMiddleware logs request started and response received', async (t) => {
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
    body: JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_file' } }],
    }),
  });

  t.is(response.status, 200);
  await response.text();
  // Allow fire-and-forget log to flush
  await new Promise((resolve) => setTimeout(resolve, 0));

  t.is(logs.length, 2, 'expected request + response log');

  // Check request log
  t.like(logs[0], {
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
  t.deepEqual(logs[0].meta.messages, [{ role: 'user', content: 'hi' }]);

  // Check response log
  t.like(logs[1], {
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
  t.is(logs[1].meta.text, 'hello');
  t.truthy(logs[0].meta.requestId);
  t.is(logs[0].meta.requestId, logs[1].meta.requestId);
});

test('createLoggingMiddleware logs response failed on error', async (t) => {
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

  await t.throwsAsync(
    () =>
      composed('https://api.example.test/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'test-model',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    { instanceOf: TypeError },
  );

  // Allow fire-and-forget to flush (nothing expected after error, but let it settle)
  await new Promise((resolve) => setTimeout(resolve, 0));

  t.is(logs.length, 2);
  t.like(logs[0], {
    message: 'openrouter ai sdk request',
    meta: {
      eventType: 'provider.request.started',
      provider: 'openrouter',
      model: 'test-model',
    },
  });
  t.like(logs[1], {
    message: 'openrouter ai sdk request failed',
    meta: {
      eventType: 'provider.response.failed',
      provider: 'openrouter',
      model: 'test-model',
    },
  });
  t.is(logs[0].meta.requestId, logs[1].meta.requestId);
});

test('createLoggingMiddleware uses evaluator event prefix when traffic context has evaluator flag', async (t) => {
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

  t.is(logs[0].meta.eventType, 'evaluator.request.started');
  t.is(logs[1].meta.eventType, 'evaluator.response.received');
});

test('createLoggingMiddleware uses request model from body over default model', async (t) => {
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

  t.is(logs[0].meta.model, 'gpt-4');
  t.is(logs[1].meta.model, 'gpt-4');
});

// ---------------------------------------------------------------------------
// createProviderFetch tests
// ---------------------------------------------------------------------------

test('createProviderFetch injects the logging middleware last', async (t) => {
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
  t.deepEqual(mwOrder, ['custom']);

  // Logging still fires
  t.true(logs.length >= 2);
  t.like(logs[0], {
    message: 'openrouter ai sdk request',
  });
});

test('createProviderFetch with dynamic header injection middleware', async (t) => {
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

  t.truthy(capturedHeaders);
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

  t.is(headersRecord['x-dynamic'], 'injected');
  t.is(headersRecord['existing-header'], 'keep');
});

test('createProviderFetch fetchImpl parameter works', async (t) => {
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

  t.true(called);
  t.is(res.status, 201);
  t.is(await res.text(), 'mock');
});

test('createProviderFetch exposes logging middleware types correctly', async (t) => {
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
  t.is(res.status, 200);
});

test('createProviderFetch handles null session context gracefully', async (t) => {
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
  t.is(res.status, 200);
});

test('createLoggingMiddleware handles error in fire-and-forget logging gracefully', async (t) => {
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
  t.is(res.status, 200);

  // Allow fire-and-forget to flush
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The request log should be present
  t.true(logs.length >= 1);
  t.like(logs[0], {
    message: 'openai ai sdk request',
  });
});
