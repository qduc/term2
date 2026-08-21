import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProvider } from './index.js';
import {
  GROK_BASE_URL,
  GROK_CLIENT_VERSION,
  buildGrokFetch,
  createGrokStreamedModel,
  fetchGrokModels,
} from './grok.provider.js';
import { OpenAIResponsesModelWithPromptCacheKey } from './openai-responses-model.js';
import { OpenAIChatCompletionsModel } from './openai-chat-completions-model.js';
import { GROK_RESPONSES_OPAQUE_TAG } from './provider-opaque-compatibility.js';
import { GrokTokenManager, saveGrokTokens } from './grok-auth.js';

const silentLogging = {
  debug: () => {},
  error: () => {},
  info: () => {},
  warn: () => {},
  security: () => {},
  getCorrelationId: () => undefined,
  setCorrelationId: () => {},
  clearCorrelationId: () => {},
} as any;

function tokenFile(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-provider-')), 'grok-auth.json');
  saveGrokTokens({ access_token: 'live-token', expires_at: Date.now() + 3_600_000 }, file);
  return file;
}

const deps = () =>
  ({
    settingsService: { get: () => undefined, getDynamic: () => undefined },
    loggingService: silentLogging,
  } as any);

describe('grok provider registration', () => {
  it('registers under the id the settings and menus address it by', () => {
    const provider = getProvider('grok');

    expect(provider?.label).toBe('Grok');
    expect(provider?.createStreamedModel).toBeTypeOf('function');
    // The CLI chat proxy has no server-side conversation state to chain onto.
    expect(provider?.capabilities?.supportsConversationChaining).toBe(false);
  });
});

describe('fetchGrokModels', () => {
  it('maps the proxy model list, carrying each model default reasoning effort', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        object: 'list',
        data: [
          { id: 'grok-4.6', name: 'Grok 4.6', reasoning_effort: 'high' },
          { id: 'grok-4.5', name: 'Grok 4.5' },
        ],
      }),
    );
    vi.spyOn(GrokTokenManager.prototype, 'getOrRefreshAccessToken').mockResolvedValue('live-token');

    const models = await fetchGrokModels(deps(), fetchImpl as any);

    expect(models).toEqual([
      { id: 'grok-4.6', name: 'Grok 4.6', default_reasoning_level: 'high' },
      { id: 'grok-4.5', name: 'Grok 4.5', default_reasoning_level: undefined },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe(`${GROK_BASE_URL}/models`);
    expect(init.headers.Authorization).toBe('Bearer live-token');
    expect(init.headers['x-grok-client-version']).toBe(GROK_CLIENT_VERSION);
    vi.restoreAllMocks();
  });

  it('reports the status when the proxy rejects the list request', async () => {
    vi.spyOn(GrokTokenManager.prototype, 'getOrRefreshAccessToken').mockResolvedValue('live-token');
    const fetchImpl = vi.fn(async () => new Response('no', { status: 403 }));

    await expect(fetchGrokModels(deps(), fetchImpl as any)).rejects.toThrow(/403/);
    vi.restoreAllMocks();
  });
});

describe('grok request headers', () => {
  it('attaches the OAuth token and the client version the proxy requires', async () => {
    const manager = new GrokTokenManager({ authPath: tokenFile() });
    const seen: Array<{ url: any; init: any }> = [];
    const upstream = vi.fn(async (url: any, init: any) => {
      seen.push({ url, init });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    // The composer binds the ambient fetch when it is built, so stub first.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = upstream as any;
    try {
      const grokFetch = buildGrokFetch(
        { settingsService: { get: () => undefined } as any, loggingService: silentLogging } as any,
        manager,
        'grok-4.6',
      );
      await grokFetch(`${GROK_BASE_URL}/chat/completions`, { method: 'POST', body: '{}' });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const headers = new Headers(seen[0].init.headers);
    expect(headers.get('authorization')).toBe('Bearer live-token');
    expect(headers.get('x-grok-client-version')).toBe(GROK_CLIENT_VERSION);
    expect(headers.get('x-grok-client-identifier')).toBe('term2');
  });

  it('fails the request when there is no Grok login rather than sending an unauthenticated call', async () => {
    const manager = new GrokTokenManager({
      authPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grok-empty-')), 'grok-auth.json'),
      cliAuthPathResolver: () => null,
    });
    const upstream = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = upstream as any;
    const grokFetch = buildGrokFetch(
      { settingsService: { get: () => undefined } as any, loggingService: silentLogging } as any,
      manager,
      'grok-4.6',
    );
    try {
      await expect(grokFetch(`${GROK_BASE_URL}/chat/completions`, { method: 'POST', body: '{}' })).rejects.toThrow(
        /Not logged in to Grok/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});

// xAI's caching docs: "Always set `x-grok-conv-id` (or `prompt_cache_key` for
// Responses API)". The header pins a conversation to one server, and cache
// entries live per server — omit it and a request can land on a server that
// does not hold the prefix. We were sending `x-grok-session-id`, which xAI does
// not document, so cache affinity was luck.
it('sends the conversation id header xAI uses to pin prompt-cache affinity', async () => {
  const manager = new GrokTokenManager({ authPath: tokenFile() });
  const seen: Array<{ url: any; init: any }> = [];
  const upstream = vi.fn(async (url: any, init: any) => {
    seen.push({ url, init });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = upstream as any;
  try {
    const grokFetch = buildGrokFetch(
      {
        settingsService: { get: () => undefined } as any,
        loggingService: silentLogging,
        sessionContextService: { getContext: () => ({ sessionId: 'session-abc' }) } as any,
      } as any,
      manager,
      'grok-4.6',
    );
    await grokFetch(`${GROK_BASE_URL}/chat/completions`, { method: 'POST', body: '{}' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const headers = new Headers(seen[0].init.headers);
  expect(headers.get('x-grok-conv-id')).toBe('session-abc');
});

// Grok's proxy serves /v1/responses, which returns typed reasoning and
// function_call items and accepts `include: ["reasoning.encrypted_content"]`.
// Chat completions only ever gave us a reasoning *summary*, and forced the
// lossy `content: null` + tool_calls shape.
describe('grok Responses lane', () => {
  it('builds a Responses model on the grok opaque lane by default', () => {
    const model: any = createGrokStreamedModel('grok-4.6', {
      settingsService: { get: () => undefined } as any,
      loggingService: silentLogging,
    } as any);

    const inner = model.wrappedModel ?? model;
    expect(inner).toBeInstanceOf(OpenAIResponsesModelWithPromptCacheKey);
    expect(inner.lane).toBe(GROK_RESPONSES_OPAQUE_TAG);
  });

  // The proxy is a ZDR org: previous_response_id returns 404 and `store: true`
  // is silently downgraded, so chaining and server-side compaction are not
  // available however capable the wire format is.
  it('declares no chaining or context compaction, but does use a prompt cache key', () => {
    const provider = getProvider('grok');
    expect(provider?.capabilities).toMatchObject({
      supportsConversationChaining: false,
      supportsContextCompaction: false,
      supportsPromptCacheKey: true,
    });
  });

  it('falls back to chat completions when TERM2_GROK_API=chat', () => {
    const previous = process.env.TERM2_GROK_API;
    process.env.TERM2_GROK_API = 'chat';
    try {
      const model: any = createGrokStreamedModel('grok-4.6', {
        settingsService: { get: () => undefined } as any,
        loggingService: silentLogging,
      } as any);
      const inner = model.wrappedModel ?? model;
      expect(inner).toBeInstanceOf(OpenAIChatCompletionsModel);
    } finally {
      if (previous === undefined) delete process.env.TERM2_GROK_API;
      else process.env.TERM2_GROK_API = previous;
    }
  });
});
