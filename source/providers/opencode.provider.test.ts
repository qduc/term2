import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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

it('createOpencodeSessionInjector returns null for non-opencode provider', () => {
  const injector = createOpencodeSessionInjector({ type: 'anthropic', baseUrl: 'https://api.anthropic.com' });
  expect(injector).toBe(null);
});

it('createOpencodeSessionInjector returns injector for opencode type', () => {
  const injector = createOpencodeSessionInjector({ type: 'opencode' });
  expect(injector).not.toBe(null);
});

it('createOpencodeSessionInjector returns injector when baseUrl contains opencode.ai', () => {
  const injector = createOpencodeSessionInjector({ type: 'anthropic', baseUrl: 'https://opencode.ai/v1' });
  expect(injector).not.toBe(null);
});

it('createOpencodeSessionInjector returns injector when baseUrl contains OPENCODE.AI case-insensitively', () => {
  const injector = createOpencodeSessionInjector({ type: 'anthropic', baseUrl: 'https://OPENCODE.AI/v1' });
  expect(injector).not.toBe(null);
});

it('createOpencodeSessionInjector returns injector when name is opencode', () => {
  const injector = createOpencodeSessionInjector({ name: 'opencode' });
  expect(injector).not.toBe(null);
});

it('createOpencodeSessionInjector injects x-opencode-session header', () => {
  const injector = createOpencodeSessionInjector({ type: 'opencode' })!;
  const result = injector({ headers: { 'Content-Type': 'application/json' } });

  expect(result).not.toBe(null);
  expect(result?.headers).toBeTruthy();
  // Find x-opencode-session in the headers
  const rawHeaders = result!.headers as Record<string, string>;
  const keys = Object.keys(rawHeaders);
  const sessionHeader = keys.find((k) => k.toLowerCase() === 'x-opencode-session');
  expect(sessionHeader).toBeTruthy();
  expect(rawHeaders[sessionHeader!]).toMatch(/^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
});

it('createOpencodeSessionInjector session ID is stable across multiple calls', () => {
  const injector = createOpencodeSessionInjector({ type: 'opencode' })!;

  const first = injector({});
  const second = injector({});

  const getHeader = (r: RequestInit | null): string | undefined => {
    const h = r!.headers as Record<string, string>;
    return Object.values(h).find((v) => v.startsWith('ses_'));
  };

  expect(getHeader(first), 'session ID should be stable').toBe(getHeader(second));
});

it('createOpencodeSessionInjector preserves existing headers', () => {
  const injector = createOpencodeSessionInjector({ type: 'opencode' })!;
  const result = injector({
    headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-test' },
  });

  const h = result!.headers as Record<string, string>;
  expect(h['anthropic-version']).toBe('2023-06-01');
  expect(h['x-api-key']).toBe('sk-test');
  expect(Object.keys(h).find((k) => k.toLowerCase() === 'x-opencode-session')).toBeTruthy();
});

it('createOpencodeSessionInjector uses fallbackSessionIdOverride when provided', () => {
  const injector = createOpencodeSessionInjector(
    { type: 'opencode' },
    { fallbackSessionIdOverride: 'ses_123456789012abcABC0abcABC0ab' },
  )!;

  const result = injector({});
  const h = result!.headers as Record<string, string>;
  const sessionKey = Object.keys(h).find((k) => k.toLowerCase() === 'x-opencode-session')!;
  expect(h[sessionKey]).toBe('ses_123456789012abcABC0abcABC0ab');
});

it('createOpencodeSessionInjector generated fallback takes precedence over traffic context session ID', () => {
  const injector = createOpencodeSessionInjector(
    { type: 'opencode' },
    { sessionContextService: makeSessionContextService('conversation-session-abc') },
  )!;

  const result = injector({});
  const h = result!.headers as Record<string, string>;
  const sessionKey = Object.keys(h).find((k) => k.toLowerCase() === 'x-opencode-session')!;
  // The injector always generates a fresh fallback ID for opencode providers,
  // so we should get a generated ses_* ID, not the traffic context one.
  expect(h[sessionKey]).not.toBe('conversation-session-abc');
  expect(h[sessionKey]).toMatch(/^ses_/);
});

it('createOpencodeSessionInjector generated ID is stable for same traffic context sessionId', () => {
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

  expect(h1[key1], 'Session IDs generated for the same traffic context sessionId should be equal').toBe(h2[key2]);

  // Change trafficSessionId
  trafficSessionId = 'different-session-id';
  const h3 = injector1({})!.headers as Record<string, string>;
  const key3 = Object.keys(h3).find((k) => k.toLowerCase() === 'x-opencode-session')!;
  expect(h1[key1], 'Session IDs for different traffic context sessionIds should be different').not.toBe(h3[key3]);
});

it('createOpencodeSessionInjector fallbackSessionIdOverride takes precedence over traffic context', () => {
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
  expect(h[sessionKey]).toBe('ses_overridden1234567890123456');
});

it('createOpencodeSessionInjector preserves existing body and other init fields', () => {
  const injector = createOpencodeSessionInjector({ type: 'opencode' })!;

  const result = injector({
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    headers: { 'content-type': 'application/json' },
  });

  expect(result?.method).toBe('POST');
  expect(result?.body).toBe(JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }));
});

// ---------------------------------------------------------------------------
// generateOpencodeSessionId
// ---------------------------------------------------------------------------

it('generateOpencodeSessionId produces a 30-char session ID', () => {
  const id = generateOpencodeSessionId();
  expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
  expect(id.length).toBe(30);
});

it('generateOpencodeSessionId produces unique values', () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateOpencodeSessionId()));
  expect(ids.size).toBe(100);
});

it('generateOpencodeSessionId is deterministic for same effectiveSessionId', () => {
  const id1 = generateOpencodeSessionId('session-123');
  const id2 = generateOpencodeSessionId('session-123');
  expect(id1).toBe(id2);
});

it('generateOpencodeSessionId is different for different effectiveSessionIds', () => {
  const id1 = generateOpencodeSessionId('session-123');
  const id2 = generateOpencodeSessionId('session-456');
  expect(id1).not.toBe(id2);
});

it('generateOpencodeSessionId matches length and character pools for deterministic generation', () => {
  const id = generateOpencodeSessionId('some-test-session-id-with-long-length-and-special-chars-!@#');
  expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
  expect(id.length).toBe(30);
});

// ---------------------------------------------------------------------------
// isOpencodeProvider
// ---------------------------------------------------------------------------

it('isOpencodeProvider detects opencode type', () => {
  expect(isOpencodeProvider({ type: 'opencode' })).toBe(true);
});

it('isOpencodeProvider detects opencode name', () => {
  expect(isOpencodeProvider({ name: 'opencode' })).toBe(true);
});

it('isOpencodeProvider detects opencode.ai in baseUrl', () => {
  expect(isOpencodeProvider({ baseUrl: 'https://opencode.ai/v1' })).toBe(true);
});

it('isOpencodeProvider detects OPENCODE.AI case-insensitively', () => {
  expect(isOpencodeProvider({ baseUrl: 'https://OPENCODE.AI/v1' })).toBe(true);
});

it('isOpencodeProvider returns false for non-opencode providers', () => {
  expect(isOpencodeProvider({ type: 'anthropic', baseUrl: 'https://api.anthropic.com' })).toBe(false);
  expect(isOpencodeProvider({ type: 'openai', baseUrl: 'https://api.openai.com' })).toBe(false);
  expect(isOpencodeProvider({})).toBe(false);
});

// ---------------------------------------------------------------------------
// selectOpencodeModelTransport
// ---------------------------------------------------------------------------

it('selectOpencodeModelTransport routes minimax and qwen models through Anthropic messages', () => {
  expect(selectOpencodeModelTransport('Minimax-3.5-Turbo')).toBe('anthropic-messages');
  expect(selectOpencodeModelTransport('qwen3-coder')).toBe('anthropic-messages');
});

it('selectOpencodeModelTransport routes other models through OpenAI chat completions', () => {
  expect(selectOpencodeModelTransport('gpt-oss-120b')).toBe('openai-chat-completions');
});

it('shouldApplyOpencodeAnthropicPromptCaching applies only to Anthropic Claude and qwen model IDs', () => {
  expect(shouldApplyOpencodeAnthropicPromptCaching('claude-sonnet-4-5')).toBe(true);
  expect(shouldApplyOpencodeAnthropicPromptCaching('qwen3-coder')).toBe(true);
  expect(shouldApplyOpencodeAnthropicPromptCaching('Minimax-3.5-Turbo')).toBe(false);
  expect(shouldApplyOpencodeAnthropicPromptCaching('gpt-oss-120b')).toBe(false);
});
