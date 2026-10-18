import OpenAI from 'openai';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';
import { execFile } from 'node:child_process';
import { registerProvider } from './registry.js';
import type { ProviderDeps, ProviderFetch } from './registry.js';
import { createProviderFetch } from './fetch/composer.js';
import type { FetchMiddleware } from './fetch/compose.js';
import { injectHeaders, installationVersion } from './fetch/logging-middleware.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../services/session/session-context-service.js';
import type { ISessionContextService } from '../services/service-interfaces.js';
import { OpenAIChatCompletionsModel } from './openai-chat-completions-model.js';
import { OpenAIResponsesModelWithPromptCacheKey } from './openai-responses-model.js';
import { GROK_RESPONSES_OPAQUE_TAG } from './provider-opaque-compatibility.js';
import { applyClientResponseNormalization, type CostTrailerCapture } from './openai-compatible-response-normalizer.js';
import { RetryingModel } from './retrying-model.js';
import { GrokTokenManager } from './grok-auth.js';
import type { StreamedModelTurn } from '../contracts/streamed-model-turn.js';

/**
 * Grok subscription access goes through the CLI chat proxy, not the metered
 * public xAI API: an OAuth access token is only accepted here. The proxy speaks
 * OpenAI chat completions.
 */
export const GROK_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const DEFAULT_GROK_MODEL = 'grok-4.6';

/**
 * The proxy hard-rejects requests whose client version it does not recognise
 * (HTTP 426, "Your Grok CLI version is outdated"), so the version header is
 * required, not cosmetic, and the accepted floor moves with each Grok CLI
 * release. Even an installed `grok` can lag that floor, so we ask the same
 * channel pointer the official installer uses for the current stable version.
 * Order: fresh cache, online, stale cache, installed binary, then this
 * constant, which is only the last resort and can go stale.
 */
export const GROK_CLIENT_VERSION_FALLBACK = '1.0.62';

const GROK_STABLE_VERSION_URLS = [
  'https://x.ai/cli/stable',
  'https://storage.googleapis.com/grok-build-public-artifacts/cli/stable',
];
const GROK_VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const GROK_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

let clientVersionPromise: Promise<string> | undefined;

function grokVersionCachePath(cacheDir?: string): string {
  return path.join(cacheDir || process.env.TERM2_CACHE_DIR || envPaths('term2').cache, 'grok-client-version.json');
}

function readGrokVersionCache(cachePath: string): { version: string; fresh: boolean } | null {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (typeof cached.version !== 'string' || !GROK_VERSION_PATTERN.test(cached.version)) return null;
    return { version: cached.version, fresh: Date.now() - Number(cached.timestamp) < GROK_VERSION_CACHE_TTL_MS };
  } catch {
    return null;
  }
}

async function fetchLatestGrokVersion(fetchImpl: ProviderFetch): Promise<string | null> {
  for (const url of GROK_STABLE_VERSION_URLS) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) continue;
      const version = (await response.text()).trim();
      if (GROK_VERSION_PATTERN.test(version)) return version;
    } catch {
      // try the next mirror
    }
  }
  return null;
}

function getInstalledGrokVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('grok', ['--version'], { timeout: 3000 }, (err, stdout) => {
      resolve((!err && String(stdout).match(/\b(\d+\.\d+\.\d+)\b/)?.[1]) || null);
    });
  });
}

export async function lookupGrokClientVersion(options?: {
  fetchImpl?: ProviderFetch;
  cacheDir?: string;
}): Promise<string> {
  const cachePath = grokVersionCachePath(options?.cacheDir);
  const cached = readGrokVersionCache(cachePath);
  if (cached?.fresh) return cached.version;

  const latest = await fetchLatestGrokVersion(options?.fetchImpl ?? globalThis.fetch);
  if (latest) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({ version: latest, timestamp: Date.now() }));
    } catch {
      // cache is best-effort
    }
    return latest;
  }
  return cached?.version ?? (await getInstalledGrokVersion()) ?? GROK_CLIENT_VERSION_FALLBACK;
}

/** Resolved once per process. */
export function resolveGrokClientVersion(): Promise<string> {
  clientVersionPromise ??= lookupGrokClientVersion();
  return clientVersionPromise;
}

/**
 * The proxy serves `/v1/responses`, but as a Zero Data Retention org: a
 * `previous_response_id` request returns 404 ("Previous response cannot be used
 * for this organization due to Zero Data Retention") and `store: true` comes
 * back downgraded to `store: false`. So chaining and server-side compaction
 * stay off however capable the wire format is; what the Responses lane buys
 * here is typed items and encrypted reasoning, not smaller requests.
 *
 * `prompt_cache_key` is the Responses-API spelling of the `x-grok-conv-id`
 * server-affinity hint, which is how xAI's caching docs say to hold a prefix.
 */
const GROK_CAPABILITIES = {
  supportsConversationChaining: false,
  supportsContextCompaction: false,
  supportsPromptCacheKey: true,
  promptCacheKeyPlacement: 'responses-extra-body',
  usesStrictToolSchema: false,
} as const;

/**
 * Emergency fallback to the previous chat-completions lane. Set
 * `TERM2_GROK_API=chat` if the Responses path misbehaves against a proxy
 * change; there is no reason to use it otherwise.
 */
function grokUsesChatCompletions(): boolean {
  return (process.env.TERM2_GROK_API || '').trim().toLowerCase() === 'chat';
}

function grokAuthMiddleware(
  tokenManager: GrokTokenManager,
  loggingService: { error: (msg: string, meta?: any) => void },
): FetchMiddleware {
  return async (ctx, next) => {
    try {
      const accessToken = await tokenManager.getOrRefreshAccessToken();
      const headers = injectHeaders(ctx.init?.headers, { Authorization: `Bearer ${accessToken}` });
      return next({ url: ctx.url, init: { ...ctx.init, headers } });
    } catch (err: any) {
      loggingService.error('Grok OAuth fetch interceptor error', { error: err?.message });
      throw err;
    }
  };
}

function grokHeadersMiddleware(sessionContextService?: ISessionContextService): FetchMiddleware {
  return async (ctx, next) => {
    const clientVersion = await resolveGrokClientVersion();
    const context = sessionContextService?.getContext();
    const sessionId = context?.sessionId;
    const cacheAffinity =
      context?.providerHistoryKey ??
      (context?.evaluator ? String(sessionId) + ':evaluator' : context?.promptCacheKey ?? sessionId);
    const headers = injectHeaders(ctx.init?.headers, {
      'x-grok-client-version': clientVersion,
      'x-grok-client-identifier': 'term2',
      'User-Agent': `term2/${installationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`,
      // xAI pins a conversation to one server by this header, and prompt-cache
      // entries live per server. Their caching docs say to always set it; the
      // undocumented `x-grok-session-id` we used to send bought no affinity.
      ...(sessionId ? { 'x-grok-conv-id': cacheAffinity, 'x-grok-session-id': sessionId } : {}),
    });
    return next({ url: ctx.url, init: { ...ctx.init, headers } });
  };
}

export function buildGrokFetch(deps: ProviderDeps, tokenManager: GrokTokenManager, defaultModel: string): typeof fetch {
  return createProviderFetch({
    providerId: 'grok',
    defaultModel,
    deps: {
      loggingService: deps.loggingService,
      sessionContextService: deps.sessionContextService ?? NULL_SESSION_CONTEXT_SERVICE,
    },
    middlewares: [
      grokAuthMiddleware(tokenManager, deps.loggingService),
      grokHeadersMiddleware(deps.sessionContextService),
    ],
  });
}

export async function fetchGrokModels(
  deps: ProviderDeps,
  fetchImpl: ProviderFetch = fetch,
): Promise<Array<{ id: string; name?: string; default_reasoning_level?: string }>> {
  const tokenManager = new GrokTokenManager({ fetchImpl, sessionAccountStore: deps.sessionAccountStore });
  const accessToken = await tokenManager.getOrRefreshAccessToken();

  const response = await fetchImpl(`${GROK_BASE_URL}/models`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-grok-client-version': await resolveGrokClientVersion(),
      'x-grok-client-identifier': 'term2',
    },
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Grok models request failed (${response.status})`);
  }

  const body = await response.json();
  const raw = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return raw
    .map((item: any) => {
      const id = item?.id || item?.model || '';
      return id
        ? {
            id,
            name: item?.name || item?.display_name,
            default_reasoning_level: item?.reasoning_effort,
          }
        : null;
    })
    .filter(Boolean) as Array<{ id: string; name?: string; default_reasoning_level?: string }>;
}

export function createGrokStreamedModel(model: string, deps: ProviderDeps): StreamedModelTurn {
  const resolvedModel = (model || deps.settingsService.get('agent.modelSelection').model || DEFAULT_GROK_MODEL).trim();
  const retryAttempts = deps.retryAttempts ?? deps.settingsService.get('agent.retryAttempts') ?? 2;

  const openAIClient = new OpenAI({
    apiKey: 'oauth',
    baseURL: process.env.GROK_BASE_URL || GROK_BASE_URL,
    maxRetries: retryAttempts,
    fetch: buildGrokFetch(deps, new GrokTokenManager({ sessionAccountStore: deps.sessionAccountStore }), resolvedModel),
  });

  const costCapture: CostTrailerCapture = {};
  applyClientResponseNormalization(openAIClient, deps.loggingService, costCapture);

  const inner = grokUsesChatCompletions()
    ? new OpenAIChatCompletionsModel(openAIClient, resolvedModel, costCapture, 'grok')
    : // HTTP only: the proxy exposes no Responses WebSocket, and chaining --
      // the reason that transport exists -- is refused for this org anyway.
      new OpenAIResponsesModelWithPromptCacheKey(
        openAIClient,
        resolvedModel,
        deps.requestCapture,
        GROK_CAPABILITIES.supportsContextCompaction,
        deps.contextCompactionSessionState,
        GROK_RESPONSES_OPAQUE_TAG,
      );

  return new RetryingModel(inner, {
    retryAttempts,
    loggingService: deps.loggingService,
    onRetry: deps.onRetry,
  });
}

registerProvider(
  {
    id: 'grok',
    label: 'Grok',
    createStreamedModel: createGrokStreamedModel,
    fetchModels: fetchGrokModels,
    sensitiveSettingKeys: [],
    capabilities: GROK_CAPABILITIES,
  },
  { builtin: true },
);
