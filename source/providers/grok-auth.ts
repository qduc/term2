import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import envPaths from 'env-paths';
import { runPkceLoopbackLogin } from './oauth-pkce.js';
import type { PkceLoginConfig } from './oauth-pkce.js';
import { OAuthAccountStore } from './oauth-account-store.js';
import type { AccountIdentity, OAuthAccount } from './oauth-account-store.js';
import { getJwtClaims } from './jwt-claims.js';
import { recordSessionAccount } from './oauth-session-account.js';

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
  /** True when this came from the grok CLI's store, so we hold no refresh token. */
  imported?: boolean;
};

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

/**
 * Import a credential from the grok CLI's store — **the access token only.**
 *
 * xAI rotates refresh tokens: each refresh invalidates the one before it. If
 * term2 carried the CLI's refresh token, the two processes would be two writers
 * on one rotation chain and the loser would be silently logged out. So this is
 * a one-way, short-lived grace: an already-logged-in host works immediately,
 * and once that access token expires the user runs `term2 --grok-login` to get
 * a rotation chain of our own.
 */
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
  // Prefer an unexpired entry; a stale one is useless to us now that we cannot
  // refresh it, but returning it still beats returning nothing when it is all
  // the host has (the caller reports the expiry as a login prompt).
  const now = Date.now();
  const isLive = (candidate: any) => {
    const expiry = parseExpiry(candidate.expires_at);
    return expiry === undefined || expiry > now;
  };
  const entry = entries.find(isLive) ?? entries[0];
  if (!entry) return null;
  return {
    access_token: entry.key,
    expires_at: parseExpiry(entry.expires_at),
    email: typeof entry.email === 'string' ? entry.email : undefined,
    user_id: typeof entry.user_id === 'string' ? entry.user_id : undefined,
    team_id: typeof entry.team_id === 'string' ? entry.team_id : undefined,
    imported: true,
  };
}

/**
 * Names a Grok account from its credential. The id must be stable across
 * logins to the same account, or switching would accumulate duplicates, so it
 * prefers the immutable subject over the display email.
 */
function identifyGrokAccount(tokens: GrokTokens): AccountIdentity {
  const claims = tokens.id_token ? getJwtClaims(tokens.id_token) : null;
  const email = tokens.email || (typeof claims?.email === 'string' ? claims.email : undefined);
  const subject = tokens.user_id || (typeof claims?.sub === 'string' ? claims.sub : undefined);
  return { id: subject || email || 'default', label: email || subject || 'Grok account' };
}

export function createGrokAccountStore(filePath = resolveGrokAuthPath()): OAuthAccountStore<GrokTokens> {
  return new OAuthAccountStore<GrokTokens>({
    filePath,
    identify: identifyGrokAccount,
    // A v1 file was a single bare credential object.
    migrateLegacy: (body: any) =>
      body && typeof body.access_token === 'string' && body.access_token
        ? { ...body, expires_at: parseExpiry(body.expires_at) }
        : null,
  });
}

/** The credential of whichever Grok account is currently selected. */
export function readStoredGrokTokens(filePath = resolveGrokAuthPath()): GrokTokens | null {
  return createGrokAccountStore(filePath).getActiveTokens();
}

/** Stores a credential as an account and makes it the active one. */
export function saveGrokTokens(tokens: GrokTokens, filePath = resolveGrokAuthPath()): void {
  createGrokAccountStore(filePath).upsert(tokens);
}

export function listGrokAccounts(filePath = resolveGrokAuthPath()): OAuthAccount<GrokTokens>[] {
  return createGrokAccountStore(filePath).list();
}

export function getActiveGrokAccount(filePath = resolveGrokAuthPath()): OAuthAccount<GrokTokens> | null {
  return createGrokAccountStore(filePath).getActive();
}

export function setActiveGrokAccount(accountId: string, filePath = resolveGrokAuthPath()): boolean {
  return createGrokAccountStore(filePath).setActive(accountId);
}

export function removeGrokAccount(accountId: string, filePath = resolveGrokAuthPath()): boolean {
  return createGrokAccountStore(filePath).remove(accountId);
}

/** True when term2 or the grok CLI has a usable Grok credential on this host. */
export function hasGrokLogin(): boolean {
  if (readStoredGrokTokens()) return true;
  const cliPath = resolveGrokCliAuthPath();
  const imported = cliPath ? readGrokCliTokens(cliPath) : null;
  // An imported token cannot be refreshed, so an expired one is not a login.
  return Boolean(imported && (imported.expires_at === undefined || imported.expires_at > Date.now()));
}

function toTokens(body: any, previous?: GrokTokens): GrokTokens {
  const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : undefined;
  return {
    access_token: body?.access_token,
    refresh_token: body?.refresh_token || previous?.refresh_token,
    id_token: body?.id_token || previous?.id_token,
    expires_at: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    email: previous?.email ?? claimedEmail(body?.id_token),
    user_id: previous?.user_id ?? claimedSubject(body?.id_token),
    team_id: previous?.team_id,
  };
}

function claimedEmail(idToken: unknown): string | undefined {
  const claims = typeof idToken === 'string' ? getJwtClaims(idToken) : null;
  return typeof claims?.email === 'string' ? claims.email : undefined;
}

function claimedSubject(idToken: unknown): string | undefined {
  const claims = typeof idToken === 'string' ? getJwtClaims(idToken) : null;
  return typeof claims?.sub === 'string' ? claims.sub : undefined;
}

/**
 * Resolves a live access token, refreshing it when it is expired or close to
 * expiring. Concurrent callers share one refresh so the single-use refresh
 * token is not spent twice.
 */
export class GrokTokenManager {
  private activeRefresh: Promise<string> | null = null;
  /**
   * The account this manager resolved first, held for its whole lifetime.
   *
   * Selecting a different account in the UI changes the store's active pointer,
   * but a running session keeps authenticating as whoever it started as —
   * provider response chaining is bound to that identity, so swapping it
   * mid-session would break the chain.
   */
  private pinnedAccountId: string | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly authPath: string;
  private readonly cliAuthPathResolver: () => string | null;

  constructor(options?: { fetchImpl?: typeof fetch; authPath?: string; cliAuthPathResolver?: () => string | null }) {
    this.fetchImpl = options?.fetchImpl || globalThis.fetch;
    this.authPath = options?.authPath || resolveGrokAuthPath();
    this.cliAuthPathResolver = options?.cliAuthPathResolver || resolveGrokCliAuthPath;
  }

  private load(): GrokTokens | null {
    const store = createGrokAccountStore(this.authPath);
    const pinned = this.pinnedAccountId ? store.get(this.pinnedAccountId) : null;
    // Falls back to the active account if the pinned one was signed out.
    const account = pinned ?? store.getActive();
    if (account) {
      this.pinnedAccountId = account.id;
      recordSessionAccount('grok', account.id);
      return account.tokens;
    }
    const cliPath = this.cliAuthPathResolver();
    return cliPath ? readGrokCliTokens(cliPath) : null;
  }

  /** The account id this session is authenticating as, once it has resolved one. */
  getPinnedAccountId(): string | null {
    return this.pinnedAccountId;
  }

  async getOrRefreshAccessToken(): Promise<string> {
    const tokens = this.load();
    if (!tokens) {
      throw new Error('Not logged in to Grok. Run `term2 --grok-login` (or `grok login`) first.');
    }

    const expiringSoon = tokens.expires_at !== undefined && Date.now() + REFRESH_SKEW_MS >= tokens.expires_at;
    if (!expiringSoon) return tokens.access_token;

    if (!tokens.refresh_token) {
      throw new Error(
        tokens.imported
          ? 'The access token imported from the `grok` CLI has expired. Run `term2 --grok-login` so term2 holds its own credential.'
          : 'Grok access token expired and no refresh token is stored. Run `term2 --grok-login` again.',
      );
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
        // Refresh the account this session is pinned to, not whichever the
        // user has since selected.
        const store = createGrokAccountStore(this.authPath);
        if (this.pinnedAccountId) store.updateTokens(this.pinnedAccountId, refreshed);
        else store.updateActiveTokens(refreshed);
        return refreshed.access_token;
      } finally {
        this.activeRefresh = null;
      }
    })();

    return this.activeRefresh;
  }
}

export const GROK_PKCE_CONFIG: PkceLoginConfig = {
  label: 'Grok',
  clientId: GROK_OIDC_CLIENT_ID,
  authorizeEndpoint: GROK_AUTHORIZE_ENDPOINT,
  tokenEndpoint: GROK_TOKEN_ENDPOINT,
  redirectPorts: [GROK_REDIRECT_PORT],
  redirectUriFor: () => GROK_REDIRECT_URI,
  callbackPath: '/callback',
  scopes: GROK_SCOPES,
  portConflictHint: 'often a running `grok login`',
};

/**
 * Runs the browser OAuth + PKCE flow and persists the resulting tokens into
 * term2's own store. Resolves only after the human finishes in the browser.
 */
export async function loginToGrok(options?: {
  fetchImpl?: typeof fetch;
  authPath?: string;
  openBrowser?: (url: string) => void;
  onPrompt?: (url: string) => void;
  signal?: AbortSignal;
}): Promise<GrokTokens> {
  const body = await runPkceLoopbackLogin(GROK_PKCE_CONFIG, {
    fetchImpl: options?.fetchImpl,
    openBrowser: options?.openBrowser,
    onPrompt: options?.onPrompt,
    signal: options?.signal,
  });

  const tokens = toTokens(body);
  saveGrokTokens(tokens, options?.authPath ?? resolveGrokAuthPath());
  return tokens;
}
