import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import envPaths from 'env-paths';

/**
 * Grok (xAI) OAuth 2.0 + PKCE login and token storage.
 *
 * The public desktop client id, the loopback redirect, and the scope set below
 * are the ones the official `grok` CLI registers with https://auth.x.ai. They
 * are public by design (a native app cannot keep a secret), but the values are
 * load-bearing: the authorization server rejects an unregistered redirect_uri
 * or client_id outright, so do not "clean them up" into settings without
 * re-registering.
 */
export const GROK_OIDC_ISSUER = 'https://auth.x.ai';
export const GROK_OIDC_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_AUTHORIZE_ENDPOINT = `${GROK_OIDC_ISSUER}/oauth2/authorize`;
export const GROK_TOKEN_ENDPOINT = `${GROK_OIDC_ISSUER}/oauth2/token`;
/** The authorization server only accepts this exact loopback callback. */
export const GROK_REDIRECT_PORT = 22255;
export const GROK_REDIRECT_URI = `http://localhost:${GROK_REDIRECT_PORT}/callback`;
export const GROK_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'grok-cli:access',
  'api:access',
  'conversations:read',
  'conversations:write',
];

/** Refresh this long before the access token's stated expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type GrokTokens = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  /** Absolute expiry in epoch milliseconds. */
  expires_at?: number;
  email?: string;
  user_id?: string;
  team_id?: string;
};

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** term2's own credential file. We never write to the grok CLI's store. */
export function resolveGrokAuthPath(): string {
  const dir = process.env.TERM2_CONFIG_DIR || envPaths('term2').config;
  return path.join(dir, 'grok-auth.json');
}

/**
 * The official `grok` CLI's credential file, used read-only as a fallback so a
 * host that already ran `grok login` works without a second login. Its store is
 * keyed by `<issuer>::<client_id>` and holds many scopes at once.
 */
export function resolveGrokCliAuthPath(): string | null {
  const home = process.env.GROK_HOME || (os.homedir() ? path.join(os.homedir(), '.grok') : null);
  if (!home) return null;
  const candidate = path.join(home, 'auth.json');
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Read a grok-CLI auth.json entry, preferring one that carries a refresh token. */
export function readGrokCliTokens(filePath: string): GrokTokens | null {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  const entries = Object.values(parsed ?? {}).filter(
    (entry: any) => entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key,
  ) as any[];
  const entry = entries.find((candidate) => typeof candidate.refresh_token === 'string') ?? entries[0];
  if (!entry) return null;
  return {
    access_token: entry.key,
    refresh_token: typeof entry.refresh_token === 'string' ? entry.refresh_token : undefined,
    expires_at: parseExpiry(entry.expires_at),
    email: typeof entry.email === 'string' ? entry.email : undefined,
    user_id: typeof entry.user_id === 'string' ? entry.user_id : undefined,
    team_id: typeof entry.team_id === 'string' ? entry.team_id : undefined,
  };
}

export function readStoredGrokTokens(filePath = resolveGrokAuthPath()): GrokTokens | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed.access_token === 'string' && parsed.access_token) {
      return { ...parsed, expires_at: parseExpiry(parsed.expires_at) };
    }
  } catch {
    // Fall through to the CLI store.
  }
  return null;
}

export function saveGrokTokens(tokens: GrokTokens, filePath = resolveGrokAuthPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(tokens, null, 2), { mode: 0o600, encoding: 'utf8' });
  fs.renameSync(tmpPath, filePath);
}

/** True when term2 or the grok CLI has a usable Grok credential on this host. */
export function hasGrokLogin(): boolean {
  if (readStoredGrokTokens()) return true;
  const cliPath = resolveGrokCliAuthPath();
  return Boolean(cliPath && readGrokCliTokens(cliPath));
}

function toTokens(body: any, previous?: GrokTokens): GrokTokens {
  const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : undefined;
  return {
    access_token: body?.access_token,
    refresh_token: body?.refresh_token || previous?.refresh_token,
    id_token: body?.id_token || previous?.id_token,
    expires_at: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    email: previous?.email,
    user_id: previous?.user_id,
    team_id: previous?.team_id,
  };
}

/**
 * Resolves a live access token, refreshing it when it is expired or close to
 * expiring. Concurrent callers share one refresh so the single-use refresh
 * token is not spent twice.
 */
export class GrokTokenManager {
  private activeRefresh: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly authPath: string;
  private readonly cliAuthPathResolver: () => string | null;

  constructor(options?: { fetchImpl?: typeof fetch; authPath?: string; cliAuthPathResolver?: () => string | null }) {
    this.fetchImpl = options?.fetchImpl || globalThis.fetch;
    this.authPath = options?.authPath || resolveGrokAuthPath();
    this.cliAuthPathResolver = options?.cliAuthPathResolver || resolveGrokCliAuthPath;
  }

  private load(): GrokTokens | null {
    const stored = readStoredGrokTokens(this.authPath);
    if (stored) return stored;
    const cliPath = this.cliAuthPathResolver();
    return cliPath ? readGrokCliTokens(cliPath) : null;
  }

  async getOrRefreshAccessToken(): Promise<string> {
    const tokens = this.load();
    if (!tokens) {
      throw new Error('Not logged in to Grok. Run `term2 --grok-login` (or `grok login`) first.');
    }

    const expiringSoon = tokens.expires_at !== undefined && Date.now() + REFRESH_SKEW_MS >= tokens.expires_at;
    if (!expiringSoon) return tokens.access_token;

    if (!tokens.refresh_token) {
      throw new Error('Grok access token expired and no refresh token is stored. Run `term2 --grok-login` again.');
    }

    if (this.activeRefresh) return this.activeRefresh;

    this.activeRefresh = (async () => {
      try {
        const response = await this.fetchImpl(GROK_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token!,
            client_id: GROK_OIDC_CLIENT_ID,
          }).toString(),
        });
        if (!response.ok) {
          throw new Error(`Grok token refresh failed with status ${response.status}`);
        }
        const body = await response.json();
        if (!body?.access_token) {
          throw new Error('Grok refresh response did not contain access_token');
        }
        const refreshed = toTokens(body, tokens);
        saveGrokTokens(refreshed, this.authPath);
        return refreshed.access_token;
      } finally {
        this.activeRefresh = null;
      }
    })();

    return this.activeRefresh;
  }
}

function openInBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // The caller always prints the URL, so a failed launcher is not fatal.
  }
}

/**
 * Runs the browser OAuth + PKCE flow and persists the resulting tokens.
 *
 * Resolves only after the authorization server redirects back to the loopback
 * listener, so callers should treat this as a long, human-paced operation.
 */
export async function loginToGrok(options?: {
  fetchImpl?: typeof fetch;
  authPath?: string;
  openBrowser?: (url: string) => void;
  onPrompt?: (url: string) => void;
  signal?: AbortSignal;
}): Promise<GrokTokens> {
  const fetchImpl = options?.fetchImpl || globalThis.fetch;
  const openBrowser = options?.openBrowser || openInBrowser;

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const expectedState = base64url(crypto.randomBytes(16));

  const authUrl = new URL(GROK_AUTHORIZE_ENDPOINT);
  authUrl.searchParams.set('client_id', GROK_OIDC_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', GROK_REDIRECT_URI);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('scope', GROK_SCOPES.join(' '));
  authUrl.searchParams.set('state', expectedState);

  const code = await new Promise<string>((resolve, reject) => {
    // The callback is single-use. A retried or duplicated request after the
    // socket has been torn down must not run the handler a second time.
    let settled = false;
    const server = http.createServer((req, res) => {
      if (settled) {
        res.destroy();
        return;
      }
      const requestUrl = new URL(req.url || '/', GROK_REDIRECT_URI);
      if (requestUrl.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      settled = true;
      const error = requestUrl.searchParams.get('error');
      const received = requestUrl.searchParams.get('code');
      const state = requestUrl.searchParams.get('state');
      const failure = error
        ? new Error(`Grok login was rejected: ${error}`)
        : state !== expectedState
        ? // A mismatched state means this callback did not come from the
          // authorization request we started; the code may be an attacker's.
          new Error('Grok login failed: OAuth state mismatch')
        : !received
        ? new Error('Grok login failed: no authorization code in callback')
        : null;

      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end(failure ? `${failure.message}\nYou can close this tab.` : 'Login complete. You can close this tab.');
      // Free the fixed callback port immediately: a keep-alive browser socket
      // would otherwise hold it and make the next login attempt fail.
      server.close();
      server.closeAllConnections?.();
      if (failure) reject(failure);
      else resolve(received!);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `Port ${GROK_REDIRECT_PORT} is in use. Grok only accepts that exact redirect, so close whatever holds it (often a running \`grok login\`) and retry.`,
            )
          : err,
      );
    });

    options?.signal?.addEventListener('abort', () => {
      server.close();
      reject(new Error('Grok login cancelled'));
    });

    server.listen(GROK_REDIRECT_PORT, '127.0.0.1', () => {
      options?.onPrompt?.(authUrl.toString());
      openBrowser(authUrl.toString());
    });
  });

  const response = await fetchImpl(GROK_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: GROK_REDIRECT_URI,
      code_verifier: verifier,
      client_id: GROK_OIDC_CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Grok token exchange failed with status ${response.status}`);
  }
  const body = await response.json();
  if (!body?.access_token) {
    throw new Error('Grok token exchange response did not contain access_token');
  }

  const tokens = toTokens(body);
  saveGrokTokens(tokens, options?.authPath ?? resolveGrokAuthPath());
  return tokens;
}
