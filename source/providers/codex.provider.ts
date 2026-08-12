import type { ContextCompactionSessionState, StreamedModelTurn } from '../contracts/streamed-model-turn.js';
import OpenAI from 'openai';
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
import type { ISessionContextService } from '../services/service-interfaces.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../services/session/session-context-service.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import envPaths from 'env-paths';
import { resolveCodexTokenPath } from './codex-auth.js';

const DEFAULT_CODEX_MODEL = 'gpt-5.3-codex';

// Decodes the JWT and extracts expiration timestamp in milliseconds
export function getJwtExpiry(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payloadJson = Buffer.from(parts[1], 'base64').toString('utf8');
    const payload = JSON.parse(payloadJson);
    if (typeof payload.exp === 'number') {
      return payload.exp * 1000;
    }
  } catch {
    // ignore
  }
  return null;
}

// Decodes the JWT and returns all its claims
export function getJwtClaims(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payloadJson = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payloadJson);
  } catch {
    return null;
  }
}

// Extracts accountId from claims in the order of precedence
export function extractAccountIdFromClaims(claims: any): string | null {
  if (!claims || typeof claims !== 'object') return null;
  if (typeof claims.chatgpt_account_id === 'string' && claims.chatgpt_account_id) {
    return claims.chatgpt_account_id;
  }
  const authClaim = claims['https://api.openai.com/auth'];
  if (
    authClaim &&
    typeof authClaim === 'object' &&
    typeof authClaim.chatgpt_account_id === 'string' &&
    authClaim.chatgpt_account_id
  ) {
    return authClaim.chatgpt_account_id;
  }
  if (Array.isArray(claims.organizations) && claims.organizations.length > 0) {
    const firstOrg = claims.organizations[0];
    if (firstOrg && typeof firstOrg === 'object' && typeof firstOrg.id === 'string' && firstOrg.id) {
      return firstOrg.id;
    }
  }
  return null;
}

// Extracts account ID from id_token, falling back to access_token
export function extractAccountId(idToken?: string, accessToken?: string): string | null {
  if (idToken) {
    const claims = getJwtClaims(idToken);
    const accountId = extractAccountIdFromClaims(claims);
    if (accountId) return accountId;
  }
  if (accessToken) {
    const claims = getJwtClaims(accessToken);
    const accountId = extractAccountIdFromClaims(claims);
    if (accountId) return accountId;
  }
  return null;
}

// Kept as a compatibility export for the provider's existing callers/tests.
export const resolveTokenPath = resolveCodexTokenPath;

export class CodexTokenManager {
  private activeRefreshPromise: Promise<string> | null = null;
  private tokenPathResolver: () => string | null;
  private fetchImpl: typeof fetch;
  private accountId: string | null = null;
  private installationId: string | null | undefined;

  constructor(options?: { tokenPathResolver?: () => string | null; fetchImpl?: typeof fetch }) {
    this.tokenPathResolver = options?.tokenPathResolver || resolveTokenPath;
    this.fetchImpl = options?.fetchImpl || (globalThis.fetch as any);
  }

  getAccountId(): string | null {
    return this.accountId;
  }

  getInstallationId(): string | null {
    if (this.installationId !== undefined) {
      return this.installationId;
    }

    const tokenPath = this.tokenPathResolver();
    if (!tokenPath) {
      this.installationId = null;
      return this.installationId;
    }

    try {
      const installationPath = path.join(path.dirname(tokenPath), 'installation_id');
      const installationId = fs.readFileSync(installationPath, 'utf8').trim();
      this.installationId = installationId || null;
    } catch {
      this.installationId = null;
    }

    return this.installationId;
  }

  async getOrRefreshAccessToken(): Promise<string> {
    const tokenPath = this.tokenPathResolver();
    if (!tokenPath) {
      throw new Error(
        'Codex token file not found. Please log in first using `npx @openai/codex login` or set CHATGPT_LOCAL_HOME/CODEX_HOME environment variables.',
      );
    }

    let fileData: any;
    try {
      fileData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    } catch (err: any) {
      throw new Error(`Failed to read/parse Codex token file at ${tokenPath}: ${err.message}`);
    }

    const accessToken = fileData?.tokens?.access_token;
    const refreshToken = fileData?.tokens?.refresh_token;
    const idToken = fileData?.tokens?.id_token;

    const resolvedAccountId = extractAccountId(idToken, accessToken) || fileData?.tokens?.account_id;
    if (resolvedAccountId) {
      this.accountId = resolvedAccountId;
    }

    if (!accessToken) {
      throw new Error(`Codex token file at ${tokenPath} is missing access_token.`);
    }

    const expiryMs = getJwtExpiry(accessToken);
    const isExpiredOrSoon = expiryMs !== null && Date.now() + 5 * 60 * 1000 >= expiryMs;

    if (!isExpiredOrSoon) {
      return accessToken;
    }

    if (!refreshToken) {
      throw new Error(
        `Codex access token is expired or expiring soon, but no refresh token is present in ${tokenPath}`,
      );
    }

    if (this.activeRefreshPromise) {
      return this.activeRefreshPromise;
    }

    this.activeRefreshPromise = (async () => {
      try {
        const response = await this.fetchImpl('https://auth.openai.com/oauth/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
            scope: 'openid profile email offline_access',
          }),
        });

        if (!response.ok) {
          throw new Error(`OpenAI token refresh failed with status ${response.status}`);
        }

        const resBody = await response.json();
        const newAccessToken = resBody.access_token;
        if (!newAccessToken) {
          throw new Error('Refresh response did not contain access_token');
        }

        const newIdToken = resBody.id_token || fileData.tokens?.id_token;
        const refreshedAccountId = extractAccountId(newIdToken, newAccessToken) || fileData?.tokens?.account_id;
        if (refreshedAccountId) {
          this.accountId = refreshedAccountId;
        }

        const updatedData = {
          ...fileData,
          tokens: {
            ...fileData.tokens,
            access_token: newAccessToken,
            refresh_token: resBody.refresh_token || fileData.tokens?.refresh_token,
            id_token: resBody.id_token || fileData.tokens?.id_token,
            ...(refreshedAccountId ? { account_id: refreshedAccountId } : {}),
          },
          last_refresh: new Date().toISOString(),
        };

        const tmpPath = `${tokenPath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(updatedData, null, 2), {
          mode: 0o600,
          encoding: 'utf-8',
        });
        fs.renameSync(tmpPath, tokenPath);

        return newAccessToken;
      } finally {
        this.activeRefreshPromise = null;
      }
    })();

    return this.activeRefreshPromise;
  }
}

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

async function getNpmCodexVersion(fetchImpl: ProviderFetch = globalThis.fetch as any): Promise<string | null> {
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
  const fetchImpl = options?.fetchImpl || (globalThis.fetch as any);
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

  // 2. Cache expired or not found, resolve client version
  let version = await getLocalCodexVersion(execImpl);

  if (!version) {
    version = await getNpmCodexVersion(fetchImpl);
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
  fetchImpl: ProviderFetch = fetch as any,
): Promise<Array<{ id: string; name?: string; default_reasoning_level?: string }>> {
  const tokenManager = new CodexTokenManager({ fetchImpl: fetchImpl as any });
  const accessToken = await tokenManager.getOrRefreshAccessToken();

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
  supportsContextCompaction: true,
  supportsPromptCacheKey: true,
  usesStrictToolSchema: true,
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
    private onRetry?: () => void,
    private readonly contextCompactionSessionState?: ContextCompactionSessionState,
  ) {}

  setRetryCallback(callback?: () => void): void {
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
      const accessToken = await tokenManager.getOrRefreshAccessToken();
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

      return next({ url: ctx.url, init: { ...ctx.init, headers } });
    } catch (err: any) {
      loggingService.error('Codex OAuth fetch interceptor error', {
        error: err.message,
      });
      throw err;
    }
  };
}

const codexSanitizeRequestMiddleware: FetchMiddleware = (ctx, next) => {
  const sanitizedInit = addCodexResponsesLiteHeader(ctx.url, sanitizeCodexRequestInit(ctx.url, ctx.init));
  if (sanitizedInit !== ctx.init) {
    return next({ url: ctx.url, init: sanitizedInit });
  }
  return next(ctx);
};

function codexHeadersMiddleware(sessionContextService?: ISessionContextService): FetchMiddleware {
  return (ctx, next) => {
    const trafficContext = sessionContextService?.getContext() ?? null;
    const sessionId = trafficContext?.sessionId;
    const userAgent = `term2/${installationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`;

    const extraHeaders: Record<string, string> = {
      originator: 'term2',
      'User-Agent': userAgent,
    };
    if (sessionId) {
      extraHeaders['session_id'] = sessionId;
    }

    const mergedHeaders = injectHeaders(ctx.init?.headers, extraHeaders);
    return next({ url: ctx.url, init: { ...ctx.init, headers: mergedHeaders } });
  };
}

// The application run loop resolves its model once per internal turn. Keep the
// provider instance session-scoped so Codex's server-history maps survive the
// tool execution and continuation turns.
const streamedProviders = new WeakMap<object, { fingerprint: string; provider: CodexProvider }>();

function codexProviderFingerprint(settingsService: { get(key: string): unknown }, retryAttempts?: number): string {
  return JSON.stringify([
    settingsService.get('agent.transport') ?? 'websocket',
    retryAttempts ?? settingsService.get('agent.retryAttempts') ?? 2,
    settingsService.get('agent.codex.websocketFirstFrameTimeoutMs') ?? 90_000,
    settingsService.get('agent.codex.websocketInterFrameTimeoutMs') ?? 600_000,
  ]);
}

// Register Codex provider
registerProvider({
  id: 'codex',
  label: 'Codex',
  createStreamedModel: (
    model,
    { settingsService, loggingService, sessionContextService, onRetry, retryAttempts, contextCompactionSessionState },
  ) => {
    const defaultModel = settingsService.get('agent.model') || 'gpt-5.3-codex';
    // A session context is the ownership boundary for continuation state. Do
    // not fall back to the settings service: it can be shared by independent
    // sessions, which would leak server-managed response history.
    const cacheKey = sessionContextService as object | undefined;
    const fingerprint = codexProviderFingerprint(settingsService, retryAttempts);
    const cached = cacheKey ? streamedProviders.get(cacheKey) : undefined;
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new Error(
          'Codex transport or retry settings changed while this session was active. Start a new session before continuing so server-managed tool-call state is not lost.',
        );
      }
      // The cache is session-scoped, but retry observers are client-scoped.
      cached.provider.setRetryCallback(onRetry);
      return cached.provider.getStreamedModel(model || defaultModel);
    }

    const tokenManager = new CodexTokenManager();

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
        },
        middlewares: [
          codexAuthMiddleware(tokenManager, loggingService),
          codexSanitizeRequestMiddleware,
          codexHeadersMiddleware(sessionContextService),
        ],
      }) as any,
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
    if (cacheKey) streamedProviders.set(cacheKey, { fingerprint, provider });
    return provider.getStreamedModel(model || defaultModel);
  },
  fetchModels: fetchCodexModels,
  clearConversations: undefined,
  sensitiveSettingKeys: [],
  capabilities: CODEX_CAPABILITIES,
});
