import test from 'ava';
import { isOpencodeProvider } from './opencode.provider.js';
import { createOpencodeSessionInjector, generateOpencodeSessionId } from './opencode-session.js';
import { selectOpencodeModelTransport, shouldApplyOpencodeAnthropicPromptCaching } from './opencode-routing.js';

const makeSessionContextService = (sessionId?: string) => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => (sessionId ? { sessionId, sessionStartedAt: '2026-01-01T00:00:00.000Z' } : null),
});

// ---------------------------------------------------------------------------
// createOpencodeSessionInjector
// ---------------------------------------------------------------------------

test('createOpencodeSessionInjector returns null for non-opencode provider', (t) => {
  const injector = createOpencodeSessionInjector({ type: 'anthropic', baseUrl: 'https://api.anthropic.com' });
  t.is(injector, null);
});

test('createOpencodeSessionInjector returns injector for opencode type', (t) => {
  const injector = createOpencodeSessionInjector({ type: 'opencode' });
  t.not(injector, null);
});

test('createOpencodeSessionInjector returns injector when baseUrl contains opencode.ai', (t) => {
  const injector = createOpencodeSessionInjector({ type: 'anthropic', baseUrl: 'https://opencode.ai/v1' });
  t.not(injector, null);
});

test('createOpencodeSessionInjector returns injector when baseUrl contains OPENCODE.AI case-insensitively', (t) => {
  const injector = createOpencodeSessionInjector({ type: 'anthropic', baseUrl: 'https://OPENCODE.AI/v1' });
  t.not(injector, null);
});

test('createOpencodeSessionInjector returns injector when name is opencode', (t) => {
  const injector = createOpencodeSessionInjector({ name: 'opencode' });
  t.not(injector, null);
});

test('createOpencodeSessionInjector injects x-opencode-session header', (t) => {
  const injector = createOpencodeSessionInjector({ type: 'opencode' })!;
  const result = injector({ headers: { 'Content-Type': 'application/json' } });

  t.not(result, null);
  t.truthy(result?.headers);
  // Find x-opencode-session in the headers
  const rawHeaders = result!.headers as Record<string, string>;
  const keys = Object.keys(rawHeaders);
  const sessionHeader = keys.find((k) => k.toLowerCase() === 'x-opencode-session');
  t.truthy(sessionHeader, 'should have x-opencode-session header');
  t.regex(rawHeaders[sessionHeader!], /^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
});

test('createOpencodeSessionInjector session ID is stable across multiple calls', (t) => {
  const injector = createOpencodeSessionInjector({ type: 'opencode' })!;

  const first = injector({});
  const second = injector({});

  const getHeader = (r: RequestInit | null): string | undefined => {
    const h = r!.headers as Record<string, string>;
    return Object.values(h).find((v) => v.startsWith('ses_'));
  };

  t.is(getHeader(first), getHeader(second), 'session ID should be stable');
});

test('createOpencodeSessionInjector preserves existing headers', (t) => {
  const injector = createOpencodeSessionInjector({ type: 'opencode' })!;
  const result = injector({
    headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-test' },
  });

  const h = result!.headers as Record<string, string>;
  t.is(h['anthropic-version'], '2023-06-01');
  t.is(h['x-api-key'], 'sk-test');
  t.truthy(Object.keys(h).find((k) => k.toLowerCase() === 'x-opencode-session'));
});

test('createOpencodeSessionInjector uses fallbackSessionIdOverride when provided', (t) => {
  const injector = createOpencodeSessionInjector(
    { type: 'opencode' },
    { fallbackSessionIdOverride: 'ses_123456789012abcABC0abcABC0ab' },
  )!;

  const result = injector({});
  const h = result!.headers as Record<string, string>;
  const sessionKey = Object.keys(h).find((k) => k.toLowerCase() === 'x-opencode-session')!;
  t.is(h[sessionKey], 'ses_123456789012abcABC0abcABC0ab');
});

test('createOpencodeSessionInjector generated fallback takes precedence over traffic context session ID', (t) => {
  const injector = createOpencodeSessionInjector(
    { type: 'opencode' },
    { sessionContextService: makeSessionContextService('conversation-session-abc') },
  )!;

  const result = injector({});
  const h = result!.headers as Record<string, string>;
  const sessionKey = Object.keys(h).find((k) => k.toLowerCase() === 'x-opencode-session')!;
  // The injector always generates a fresh fallback ID for opencode providers,
  // so we should get a generated ses_* ID, not the traffic context one.
  t.not(h[sessionKey], 'conversation-session-abc');
  t.regex(h[sessionKey], /^ses_/);
});

test('createOpencodeSessionInjector generated ID is stable for same traffic context sessionId', (t) => {
  let trafficSessionId = 'stable-session-id';
  const sessionContextService = {
    runWithContext: <T>(_context: any, fn: () => T) => fn(),
    getContext: () => ({
      sessionId: trafficSessionId,
      sessionStartedAt: '2026-01-01T00:00:00.000Z',
    }),
  };

  const injector1 = createOpencodeSessionInjector({ type: 'opencode' }, { sessionContextService })!;
  const injector2 = createOpencodeSessionInjector({ type: 'opencode' }, { sessionContextService })!;

  const h1 = injector1({})!.headers as Record<string, string>;
  const h2 = injector2({})!.headers as Record<string, string>;

  const key1 = Object.keys(h1).find((k) => k.toLowerCase() === 'x-opencode-session')!;
  const key2 = Object.keys(h2).find((k) => k.toLowerCase() === 'x-opencode-session')!;

  t.is(h1[key1], h2[key2], 'Session IDs generated for the same traffic context sessionId should be equal');

  // Change trafficSessionId
  trafficSessionId = 'different-session-id';
  const h3 = injector1({})!.headers as Record<string, string>;
  const key3 = Object.keys(h3).find((k) => k.toLowerCase() === 'x-opencode-session')!;
  t.not(h1[key1], h3[key3], 'Session IDs for different traffic context sessionIds should be different');
});

test('createOpencodeSessionInjector fallbackSessionIdOverride takes precedence over traffic context', (t) => {
  const injector = createOpencodeSessionInjector(
    { type: 'opencode' },
    {
      sessionContextService: makeSessionContextService('conversation-session-abc'),
      fallbackSessionIdOverride: 'ses_overridden1234567890123456',
    },
  )!;

  const result = injector({});
  const h = result!.headers as Record<string, string>;
  const sessionKey = Object.keys(h).find((k) => k.toLowerCase() === 'x-opencode-session')!;
  t.is(h[sessionKey], 'ses_overridden1234567890123456');
});

test('createOpencodeSessionInjector preserves existing body and other init fields', (t) => {
  const injector = createOpencodeSessionInjector({ type: 'opencode' })!;

  const result = injector({
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    headers: { 'content-type': 'application/json' },
  });

  t.is(result?.method, 'POST');
  t.is(result?.body, JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }));
});

// ---------------------------------------------------------------------------
// generateOpencodeSessionId
// ---------------------------------------------------------------------------

test('generateOpencodeSessionId produces a 30-char session ID', (t) => {
  const id = generateOpencodeSessionId();
  t.regex(id, /^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
  t.is(id.length, 30);
});

test('generateOpencodeSessionId produces unique values', (t) => {
  const ids = new Set(Array.from({ length: 100 }, () => generateOpencodeSessionId()));
  t.is(ids.size, 100);
});

test('generateOpencodeSessionId is deterministic for same effectiveSessionId', (t) => {
  const id1 = generateOpencodeSessionId('session-123');
  const id2 = generateOpencodeSessionId('session-123');
  t.is(id1, id2);
});

test('generateOpencodeSessionId is different for different effectiveSessionIds', (t) => {
  const id1 = generateOpencodeSessionId('session-123');
  const id2 = generateOpencodeSessionId('session-456');
  t.not(id1, id2);
});

test('generateOpencodeSessionId matches length and character pools for deterministic generation', (t) => {
  const id = generateOpencodeSessionId('some-test-session-id-with-long-length-and-special-chars-!@#');
  t.regex(id, /^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
  t.is(id.length, 30);
});

// ---------------------------------------------------------------------------
// isOpencodeProvider
// ---------------------------------------------------------------------------

test('isOpencodeProvider detects opencode type', (t) => {
  t.true(isOpencodeProvider({ type: 'opencode' }));
});

test('isOpencodeProvider detects opencode name', (t) => {
  t.true(isOpencodeProvider({ name: 'opencode' }));
});

test('isOpencodeProvider detects opencode.ai in baseUrl', (t) => {
  t.true(isOpencodeProvider({ baseUrl: 'https://opencode.ai/v1' }));
});

test('isOpencodeProvider detects OPENCODE.AI case-insensitively', (t) => {
  t.true(isOpencodeProvider({ baseUrl: 'https://OPENCODE.AI/v1' }));
});

test('isOpencodeProvider returns false for non-opencode providers', (t) => {
  t.false(isOpencodeProvider({ type: 'anthropic', baseUrl: 'https://api.anthropic.com' }));
  t.false(isOpencodeProvider({ type: 'openai', baseUrl: 'https://api.openai.com' }));
  t.false(isOpencodeProvider({}));
});

// ---------------------------------------------------------------------------
// selectOpencodeModelTransport
// ---------------------------------------------------------------------------

test('selectOpencodeModelTransport routes minimax and qwen models through Anthropic messages', (t) => {
  t.is(selectOpencodeModelTransport('Minimax-3.5-Turbo'), 'anthropic-messages');
  t.is(selectOpencodeModelTransport('qwen3-coder'), 'anthropic-messages');
});

test('selectOpencodeModelTransport routes other models through OpenAI chat completions', (t) => {
  t.is(selectOpencodeModelTransport('gpt-oss-120b'), 'openai-chat-completions');
});

test('shouldApplyOpencodeAnthropicPromptCaching applies only to Anthropic Claude and qwen model IDs', (t) => {
  t.true(shouldApplyOpencodeAnthropicPromptCaching('claude-sonnet-4-5'));
  t.true(shouldApplyOpencodeAnthropicPromptCaching('qwen3-coder'));
  t.false(shouldApplyOpencodeAnthropicPromptCaching('Minimax-3.5-Turbo'));
  t.false(shouldApplyOpencodeAnthropicPromptCaching('gpt-oss-120b'));
});
