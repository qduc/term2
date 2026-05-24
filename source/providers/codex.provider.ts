import { Runner } from '@openai/agents';
import { getDefaultModel } from '@openai/agents-core';
import OpenAI from 'openai';
import { CodexResponsesModel } from './codex-responses-model.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerProvider } from './registry.js';
import type { ProviderDeps, ProviderFetch } from './registry.js';
import { createAiSdkLoggingFetch } from './ai-sdk-logging-fetch.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import envPaths from 'env-paths';

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

// Searches token file locations in predefined priority order
export function resolveTokenPath(): string | null {
  const candidates: string[] = [];

  if (process.env.CHATGPT_LOCAL_HOME) {
    candidates.push(path.join(process.env.CHATGPT_LOCAL_HOME, 'auth.json'));
    candidates.push(process.env.CHATGPT_LOCAL_HOME);
  }
  if (process.env.CODEX_HOME) {
    candidates.push(path.join(process.env.CODEX_HOME, 'auth.json'));
    candidates.push(process.env.CODEX_HOME);
  }

  const home = os.homedir();
  if (home) {
    candidates.push(path.join(home, '.chatgpt-local', 'auth.json'));
    candidates.push(path.join(home, '.codex', 'auth.json'));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export class CodexTokenManager {
  private activeRefreshPromise: Promise<string> | null = null;
  private tokenPathResolver: () => string | null;
  private fetchImpl: typeof fetch;
  private accountId: string | null = null;

  constructor(options?: { tokenPathResolver?: () => string | null; fetchImpl?: typeof fetch }) {
    this.tokenPathResolver = options?.tokenPathResolver || resolveTokenPath;
    this.fetchImpl = options?.fetchImpl || (globalThis.fetch as any);
  }

  getAccountId(): string | null {
    return this.accountId;
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

    const lastRefreshStr = fileData?.last_refresh;
    const lastRefreshMs = lastRefreshStr ? Date.parse(lastRefreshStr) : NaN;
    const timeSinceLastRefresh = isNaN(lastRefreshMs) ? Infinity : Date.now() - lastRefreshMs;
    const isRefreshNeeded = isExpiredOrSoon || timeSinceLastRefresh >= 55 * 60 * 1000;

    if (!isRefreshNeeded) {
      return accessToken;
    }

    if (!refreshToken) {
      if (isExpiredOrSoon) {
        throw new Error(
          `Codex access token is expired or expiring soon, but no refresh token is present in ${tokenPath}`,
        );
      }
      return accessToken;
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
export const CODEX_REQUEST_TIMEOUT_MS = 30_000;
export const CODEX_MAX_RETRIES = 0;

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
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  // 1. Try reading from cache
  try {
    if (fs.existsSync(cachePath)) {
      const cacheContent = fs.readFileSync(cachePath, 'utf8');
      const cached: VersionCache = JSON.parse(cacheContent);
      if (typeof cached.version === 'string' && typeof cached.timestamp === 'number') {
        if (Date.now() - cached.timestamp < ONE_WEEK_MS) {
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

async function fetchCodexModels(
  _deps: ProviderDeps,
  fetchImpl: ProviderFetch = fetch as any,
): Promise<Array<{ id: string; name?: string }>> {
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
          return id ? { id, name } : null;
        })
        .filter(Boolean) as Array<{ id: string; name?: string }>;
    }
    return [];
  }

  return raw
    .map((item: any) => {
      const id = item?.slug || item?.model || '';
      const name = item?.name || item?.display_name || item?.description;
      return id ? { id, name } : null;
    })
    .filter(Boolean)
    .reverse() as Array<{ id: string; name?: string }>;
}

// Register Codex provider
registerProvider({
  id: 'codex',
  label: 'Codex',
  createRunner: ({ settingsService, loggingService }) => {
    const defaultModel = settingsService.get('agent.model') || 'gpt-5.3-codex';
    const tokenManager = new CodexTokenManager();

    const openAIClient = new OpenAI({
      apiKey: 'placeholder',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      timeout: CODEX_REQUEST_TIMEOUT_MS,
      maxRetries: CODEX_MAX_RETRIES,
      fetch: (async (url, init) => {
        try {
          const accessToken = await tokenManager.getOrRefreshAccessToken();
          const rawHeaders = init?.headers;
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

          const sanitizedInit = sanitizeCodexRequestInit(url, init);

          return createAiSdkLoggingFetch({
            provider: 'codex',
            model: defaultModel,
            loggingService,
          })(url, { ...sanitizedInit, headers });
        } catch (err: any) {
          loggingService.error('Codex OAuth fetch interceptor error', {
            error: err.message,
          });
          throw err;
        }
      }) as any,
    });

    return new Runner({
      modelProvider: {
        getModel: async (modelName?: string) =>
          new CodexResponsesModel(openAIClient as any, modelName || getDefaultModel()),
      },
    });
  },
  fetchModels: fetchCodexModels,
  clearConversations: undefined,
  sensitiveSettingKeys: [],
  capabilities: {
    supportsConversationChaining: false,
    supportsTracingControl: false,
    usesStrictToolSchema: true,
    nativePatchModelPrefixes: ['gpt-5.1'],
  },
});
