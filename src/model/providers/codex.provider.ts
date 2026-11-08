import { CodexTokenManager } from './runtime/codex-token-manager.js';
import type { ContextCompactionSessionState, StreamedModelTurn } from '../streamed-model-turn.js';
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { CodexResponsesModel, CodexResponsesTransport, CodexResponsesWSModel } from './codex-responses-model.js';
import { RetryingModel } from './retrying-model.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerProvider } from './registry.js';
import type { ProviderDeps, ProviderFetch } from './registry.js';
import { createProviderFetch } from './fetch/composer.js';
import type { FetchMiddleware } from './fetch/compose.js';
import { injectHeaders, installationVersion } from './fetch/logging-middleware.js';
import type { ISessionContextService } from '../../shared/service-interfaces.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../traffic-context.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import envPaths from 'env-paths';
import type { ProviderRetryInfo } from './retrying-model.js';

const DEFAULT_CODEX_MODEL = 'gpt-5.3-codex';

// Compatibility surface; credentials are owned separately from model transport.
export {
  CodexTokenManager,
  getJwtExpiry,
  extractAccountIdFromClaims,
  extractAccountId,
  resolveTokenPath,
} from './runtime/codex-token-manager.js';

const execAsync = promisify(exec);

const FALLBACK_CODEX_CLIENT_VERSION = '0.133.0';

interface VersionCache {
  version: string;
  timestamp: number;
}

async function getLocalCodexVersion(
  execImpl: (command: string) => Promise<{ stdout: string }> = execAsync as any,
): Promise<string | null> {
  try {
    const { stdout } = await execImpl('codex --version');
    const match = stdout.match(/\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?\b/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

async function getNpmCodexVersion(fetchImpl: ProviderFetch = globalThis.fetch): Promise<string | null> {
  try {
    const response = await fetchImpl('https://registry.npmjs.org/@openai/codex/latest');
    if (!response.ok) return null;
    const data = await response.json();
    return data?.version || null;
  } catch {
    return null;
  }
}

export async function resolveCodexClientVersion(options?: {
  fetchImpl?: ProviderFetch;
  cacheDir?: string;
  execImpl?: (command: string) => Promise<{ stdout: string }>;
}): Promise<string> {
  const fetchImpl = options?.fetchImpl || globalThis.fetch;
  const execImpl = options?.execImpl || (execAsync as any);
  const dir = options?.cacheDir || process.env.TERM2_CACHE_DIR || envPaths('term2').cache;
  const cachePath = path.join(dir, 'codex-client-version.json');
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  // 1. Try reading from cache
  try {
    if (fs.existsSync(cachePath)) {
      const cacheContent = fs.readFileSync(cachePath, 'utf8');
      const cached: VersionCache = JSON.parse(cacheContent);
      if (typeof cached.version === 'string' && typeof cached.timestamp === 'number') {
        if (Date.now() - cached.timestamp < ONE_DAY_MS) {
          return cached.version;
        }
      }
    }
  } catch {
    // Ignore cache read errors and re-fetch
  }

  // 2. Cache expired or not found, prefer the latest published client version.
  // The local CLI can lag behind the backend's model availability contract.
  let version = await getNpmCodexVersion(fetchImpl);

  if (!version) {
    version = await getLocalCodexVersion(execImpl);
  }

  if (!version) {
    version = FALLBACK_CODEX_CLIENT_VERSION;
  }

  // 3. Try writing to cache
  try {
    fs.mkdirSync(dir, { recursive: true });
    const cached: VersionCache = {
      version,
      timestamp: Date.now(),
    };
    fs.writeFileSync(cachePath, JSON.stringify(cached, null, 2), 'utf8');
  } catch {
    // Ignore cache write errors
  }

  return version;
}

export function sanitizeCodexRequestInit(url: unknown, init?: RequestInit): RequestInit | undefined {
  const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : '';
  if (!target.includes('/responses') || !init?.body || typeof init.body !== 'string') {
    return init;
  }

  try {
    const parsed = JSON.parse(init.body);
    if (!Array.isArray(parsed?.input)) {
      return init;
    }

    let normalizedInclude = parsed.include;
    if (typeof parsed.include === 'string') {
      try {
        const candidate = JSON.parse(parsed.include);
        if (Array.isArray(candidate) && candidate.every((entry) => typeof entry === 'string')) {
          normalizedInclude = candidate;
        }
      } catch {
        // ignore malformed include payloads and leave as-is
      }
    }

    if (normalizedInclude === parsed.include) {
      return init;
    }

    return {
      ...init,
      body: JSON.stringify({
        ...parsed,
        input: parsed.input,
        include: normalizedInclude,
      }),
    };
  } catch {
    return init;
  }
}

export function addCodexResponsesLiteHeader(url: unknown, init?: RequestInit): RequestInit | undefined {
  const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : '';
  if (!target.includes('/responses') || typeof init?.body !== 'string') {
    return init;
  }

  try {
    const parsed = JSON.parse(init.body);
    if (parsed?.model !== 'gpt-5.6-luna') {
      return init;
    }
  } catch {
    return init;
  }

  return {
    ...init,
    headers: injectHeaders(init.headers, { 'x-openai-internal-codex-responses-lite': 'true' }),
  };
}

async function fetchCodexModels(
  deps: ProviderDeps,
  fetchImpl: ProviderFetch = fetch,
): Promise<Array<{ id: string; name?: string; default_reasoning_level?: string }>> {
  const tokenManager = new CodexTokenManager({ fetchImpl });
  const accessToken = await tokenManager.getOrRefreshAccessToken(deps.signal);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };

  const accountId = tokenManager.getAccountId();
  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId;
  }

  const clientVersion = await resolveCodexClientVersion({ fetchImpl });
  const response = await fetchImpl(`https://chatgpt.com/backend-api/codex/models?client_version=${clientVersion}`, {
    headers,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Codex models request failed (${response.status})`);
  }

  const body = await response.json();
  const raw = body?.models || [];

  if (!Array.isArray(raw)) {
    if (Array.isArray(body)) {
      return body
        .map((item: any) => {
          const id = item?.slug || item?.model || '';
          const name = item?.name || item?.display_name || item?.description;
          const default_reasoning_level = item?.default_reasoning_level;
          return id ? { id, name, default_reasoning_level } : null;
        })
        .filter(Boolean) as Array<{ id: string; name?: string; default_reasoning_level?: string }>;
    }
    return [];
  }

  return raw
    .map((item: any) => {
      const id = item?.slug || item?.model || '';
      const name = item?.name || item?.display_name || item?.description;
      const default_reasoning_level = item?.default_reasoning_level;
      return id ? { id, name, default_reasoning_level } : null;
    })
    .filter(Boolean) as Array<{ id: string; name?: string; default_reasoning_level?: string }>;
}

const CODEX_CAPABILITIES = {
  supportsConversationChaining: true,
  // `context_management` on ordinary create requests is api.openai.com only.
  // Codex uses the Responses compaction_trigger protocol instead.
  supportsContextCompaction: false,
  supportsPromptCacheKey: true,
  usesStrictToolSchema: true,
  nativePatchModelPrefixes: ['gpt-5'],
} as const;

export class CodexProvider {
  private readonly models = new Map<string, RetryingModel>();

  constructor(
    private readonly openAIClient: OpenAI,
    private readonly tokenManager: CodexTokenManager,
    private readonly loggingService: any,
    private readonly sessionContextService: ISessionContextService | undefined,
    private readonly transport: 'websocket' | 'http',
    private readonly retryAttempts: number,
    private readonly websocketReceiveTimeouts: { firstFrameMs: number; interFrameMs: number },
    private onRetry?: (info?: ProviderRetryInfo) => void,
    private readonly contextCompactionSessionState?: ContextCompactionSessionState,
  ) {}

  setRetryCallback(callback?: (info?: ProviderRetryInfo) => void): void {
    this.onRetry = callback;
    for (const model of this.models.values()) model.setRetryCallback(callback);
  }

  getStreamedModel(modelName?: string): StreamedModelTurn {
    const resolvedModel = modelName || DEFAULT_CODEX_MODEL;
    let retryingModel = this.models.get(resolvedModel);
    if (!retryingModel) {
      // Tests inject a CodexResponsesTransport as loggingService (legacy seam).
      // Prefer that over a freshly built transport so request/response fixtures still apply.
      const injectedTransport =
        this.loggingService instanceof CodexResponsesTransport ? this.loggingService : undefined;
      const transport =
        injectedTransport ??
        new CodexResponsesTransport(this.openAIClient as any, resolvedModel, this.transport === 'websocket', {
          supportsContextCompaction: CODEX_CAPABILITIES.supportsContextCompaction,
          contextCompactionSessionState: this.contextCompactionSessionState,
        });
      const diagnosticLogger = injectedTransport ? undefined : this.loggingService;
      const selectedModel =
        this.transport === 'http'
          ? new CodexResponsesModel(this.openAIClient as any, resolvedModel, diagnosticLogger, undefined, transport)
          : new CodexResponsesWSModel(
              this.openAIClient as any,
              resolvedModel,
              this.tokenManager,
              diagnosticLogger,
              diagnosticLogger?.providerTraffic,
              this.sessionContextService,
              this.websocketReceiveTimeouts,
              undefined,
              transport,
            );
      retryingModel = new RetryingModel(selectedModel, {
        retryAttempts: this.retryAttempts,
        loggingService: this.loggingService,
        onRetry: this.onRetry,
      });
      this.models.set(resolvedModel, retryingModel);
    }
    return retryingModel;
  }

  async close(): Promise<void> {
    for (const model of this.models.values()) {
      await model.close();
    }
    this.models.clear();
  }
}

// ── Middlewares ──────────────────────────────────────────────────────────

function codexAuthMiddleware(
  tokenManager: CodexTokenManager,
  loggingService: { error: (msg: string, meta?: any) => void },
): FetchMiddleware {
  return async (ctx, next) => {
    try {
      const accessToken = await tokenManager.getOrRefreshAccessToken(ctx.init?.signal ?? undefined);
      const rawHeaders = ctx.init?.headers;
      const headers: Record<string, string> = {};
      if (rawHeaders) {
        if (typeof (rawHeaders as any).forEach === 'function') {
          (rawHeaders as any).forEach((v: string, k: string) => {
            headers[k.toLowerCase()] = String(v);
          });
        } else {
          for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
            headers[k.toLowerCase()] = String(v);
          }
        }
      }
      headers['authorization'] = `Bearer ${accessToken}`;

      const accountId = tokenManager.getAccountId();
      if (accountId) {
        headers['chatgpt-account-id'] = accountId;
      }

      const installationId = tokenManager.getInstallationId();
      if (installationId) {
        headers['x-codex-installation-id'] = installationId;
      }

      return next({ url: ctx.url, init: { ...ctx.init, headers } });
    } catch (err: any) {
      loggingService.error('Codex OAuth fetch interceptor error', {
        error: err.message,
      });
      throw err;
    }
  };
}

export function addCodexCompactHeaders(
  url: unknown,
  headers: HeadersInit,
  sessionId: string | undefined,
  body?: BodyInit | null,
  routingKey?: string,
): Record<string, string> {
  const normalizedHeaders: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalizedHeaders[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) normalizedHeaders[key] = value;
  } else if (headers) {
    for (const [key, value] of Object.entries(headers)) normalizedHeaders[key] = String(value);
  }
  let isCompaction = false;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as { input?: unknown[] };
      const input = parsed.input;
      const last = Array.isArray(input) ? input[input.length - 1] : undefined;
      isCompaction = !!last && typeof last === 'object' && (last as { type?: unknown }).type === 'compaction_trigger';
    } catch {
      // Leave ordinary request headers untouched for malformed/non-JSON bodies.
    }
  }
  if (!isCompaction || !sessionId) return normalizedHeaders;

  const threadId = sessionId;
  const turnId = randomUUID();
  const windowId = `${threadId}:1`;
  const turnMetadata = JSON.stringify({
    installation_id: normalizedHeaders['x-codex-installation-id'],
    session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    window_id: windowId,
    request_kind: 'compaction',
  });
  return {
    ...normalizedHeaders,
    'x-client-request-id': routingKey ?? threadId,
    'session-id': routingKey ?? sessionId,
    'thread-id': routingKey ?? threadId,
    'x-codex-window-id': routingKey ? `${routingKey}:1` : windowId,
    'x-codex-turn-metadata': turnMetadata,
    'x-codex-beta-features': 'remote_compaction_v2',
    'OpenAI-Beta': 'responses=experimental',
  };
}

const codexSanitizeRequestMiddleware: FetchMiddleware = (ctx, next) => {
  const sanitizedInit = addCodexResponsesLiteHeader(ctx.url, sanitizeCodexRequestInit(ctx.url, ctx.init));
  if (sanitizedInit !== ctx.init) {
    return next({ url: ctx.url, init: sanitizedInit });
  }
  return next(ctx);
};

export function codexHeadersMiddleware(sessionContextService?: ISessionContextService): FetchMiddleware {
  return (ctx, next) => {
    const trafficContext = sessionContextService?.getContext() ?? null;
    const sessionId = trafficContext?.sessionId;
    const providerHistoryKey = trafficContext?.providerHistoryKey ?? sessionId;
    const userAgent = `term2/${installationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`;

    const extraHeaders: Record<string, string> = {
      originator: 'term2',
      'User-Agent': userAgent,
    };
    if (sessionId) {
      extraHeaders['session_id'] = sessionId;
    }

    const mergedHeaders = addCodexCompactHeaders(
      ctx.url,
      injectHeaders(ctx.init?.headers, extraHeaders),
      providerHistoryKey,
      ctx.init?.body,
      trafficContext?.providerRoutingKey,
    );
    return next({ url: ctx.url, init: { ...ctx.init, headers: mergedHeaders } });
  };
}

// Register Codex provider
registerProvider(
  {
    id: 'codex',
    label: 'Codex',
    createStreamedModel: (
      model,
      {
        settingsService,
        loggingService,
        sessionContextService,
        onRetry,
        retryAttempts,
        contextCompactionSessionState,
        sessionAccountStore,
        onDispatched,
      },
    ) => {
      const defaultModel = settingsService.get('agent.modelSelection').model || 'gpt-5.3-codex';
      const tokenManager = new CodexTokenManager({ sessionAccountStore });

      const openAIClient = new OpenAI({
        apiKey: 'placeholder',
        baseURL: process.env.CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex',
        maxRetries: retryAttempts ?? settingsService.get('agent.retryAttempts') ?? 2,
        fetch: createProviderFetch({
          providerId: 'codex',
          defaultModel,
          deps: {
            loggingService,
            sessionContextService: sessionContextService ?? NULL_SESSION_CONTEXT_SERVICE,
            onDispatched,
          },
          middlewares: [
            codexAuthMiddleware(tokenManager, loggingService),
            codexSanitizeRequestMiddleware,
            codexHeadersMiddleware(sessionContextService),
          ],
        }),
      });

      const provider = new CodexProvider(
        openAIClient,
        tokenManager,
        loggingService,
        sessionContextService,
        settingsService.get('agent.transport') ?? 'websocket',
        retryAttempts ?? settingsService.get('agent.retryAttempts') ?? 2,
        {
          firstFrameMs: settingsService.get('agent.codex.websocketFirstFrameTimeoutMs') ?? 90_000,
          interFrameMs: settingsService.get('agent.codex.websocketInterFrameTimeoutMs') ?? 600_000,
        },
        onRetry,
        contextCompactionSessionState,
      );
      return provider.getStreamedModel(model || defaultModel);
    },
    defaultModelSettings: () => ({ store: false, include: ['reasoning.encrypted_content'] }),
    useModelReasoningDefault: true,
    fetchModels: fetchCodexModels,
    clearConversations: undefined,
    sensitiveSettingKeys: [],
    capabilities: CODEX_CAPABILITIES,
  },
  { builtin: true },
);
