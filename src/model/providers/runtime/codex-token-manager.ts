/** Session-owned Codex credential pinning and bounded refresh, independent of model transport. */
import fs from 'node:fs';
import path from 'node:path';
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_TOKEN_ENDPOINT,
  readCodexCliTokens,
  resolveCodexTokenPath,
  resolveTerm2CodexAuthPath,
  createCodexAccountStore,
  type CodexTokens,
} from '../codex-auth.js';
import { getJwtClaims, getJwtExpiry } from '../jwt-claims.js';
import {
  recordSessionAccount,
  createSessionAccountStore,
  getSessionAccount,
  withSessionAccountRefresh,
  waitForSessionAccountRefresh,
  type SessionAccountStore,
} from '../oauth-session-account.js';
import { ProviderReauthenticationRequiredError } from '../common/provider-errors.js';

// Re-exported so the provider's existing callers and tests keep one import site.
export { getJwtExpiry } from '../jwt-claims.js';

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

/**
 * Resolves a live Codex access token.
 *
 * term2 keeps its own credential store and **never writes to the codex CLI's
 * `auth.json`.** OpenAI rotates refresh tokens, so two processes refreshing
 * from one file are two writers on one rotation chain and the loser is silently
 * logged out. The CLI's file is read as a one-way grace only: we take its
 * short-lived access token, never its refresh token, and once that expires the
 * user runs `term2 --codex-login` to get a rotation chain of our own.
 */
export class CodexTokenManager {
  private activeRefreshPromise: Promise<string> | null = null;
  private tokenPathResolver: () => string | null;
  private authPath: string;
  private fetchImpl: typeof fetch;
  private accountId: string | null = null;
  private installationId: string | null | undefined;
  /**
   * The account this manager resolved first, held for its whole lifetime.
   *
   * Selecting a different account in the UI changes the store's active pointer,
   * but a running session keeps authenticating as whoever it started as —
   * provider response chaining is bound to that identity, so swapping it
   * mid-session would break the chain.
   */
  private pinnedAccountId: string | null = null;
  private readonly sessionAccountStore: SessionAccountStore;
  private readonly refreshTimeoutMs: number;

  constructor(options?: {
    tokenPathResolver?: () => string | null;
    authPath?: string;
    fetchImpl?: typeof fetch;
    sessionAccountStore?: SessionAccountStore;
    refreshTimeoutMs?: number;
  }) {
    this.tokenPathResolver = options?.tokenPathResolver || resolveTokenPath;
    this.authPath = options?.authPath || resolveTerm2CodexAuthPath();
    this.fetchImpl = options?.fetchImpl || globalThis.fetch;
    this.sessionAccountStore = options?.sessionAccountStore ?? createSessionAccountStore();
    this.refreshTimeoutMs = options?.refreshTimeoutMs ?? 30_000;
  }

  getAccountId(): string | null {
    return this.accountId;
  }

  getInstallationId(): string | null {
    if (this.installationId !== undefined) {
      return this.installationId;
    }

    // The installation id is a codex CLI artifact, so it is read from the CLI's
    // directory even when the credential itself is term2's own.
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

  private load(): CodexTokens | null {
    const store = createCodexAccountStore(this.authPath);
    const pinnedId = getSessionAccount('codex', this.sessionAccountStore) ?? this.pinnedAccountId;
    const pinned = pinnedId ? store.get(pinnedId) : null;
    // Falls back to the active account if the pinned one was signed out.
    const account = pinned ?? store.getActive();
    if (account) {
      this.pinnedAccountId = account.id;
      recordSessionAccount('codex', account.id, this.sessionAccountStore);
      return account.tokens;
    }
    const cliPath = this.tokenPathResolver();
    return cliPath ? readCodexCliTokens(cliPath) : null;
  }

  /** The account id this session is authenticating as, once it has resolved one. */
  getPinnedAccountId(): string | null {
    return this.pinnedAccountId;
  }

  async getOrRefreshAccessToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.activeRefreshPromise) return waitForSessionAccountRefresh(this.activeRefreshPromise, signal);
    const refresh = this.loadOrRefreshAccessToken();
    this.activeRefreshPromise = refresh;
    void refresh
      .finally(() => {
        if (this.activeRefreshPromise === refresh) this.activeRefreshPromise = null;
      })
      .catch(() => {});
    return waitForSessionAccountRefresh(refresh, signal);
  }

  private async loadOrRefreshAccessToken(): Promise<string> {
    for (;;) {
      const tokens = this.loadTokens();
      const valid = this.currentAccessToken(tokens);
      if (valid !== undefined) return valid;
      const account = this.pinnedAccountId;
      const refreshed = await withSessionAccountRefresh(
        this.sessionAccountStore,
        'codex',
        this.authPath,
        account,
        async () => {
          const latest = this.loadTokens();
          // A removed pin may select a different account while this request waits.
          // Release this account's admission before acquiring the fallback account.
          if (this.pinnedAccountId !== account) return undefined;
          return this.currentAccessToken(latest) ?? this.refreshAccessToken(latest);
        },
      );
      if (refreshed !== undefined) return refreshed;
    }
  }

  private loadTokens(): CodexTokens {
    const tokens = this.load();
    if (!tokens) {
      throw new ProviderReauthenticationRequiredError(
        'Not logged in to Codex. Run `term2 --codex-login` (or `npx @openai/codex login`) first, or set CHATGPT_LOCAL_HOME/CODEX_HOME.',
      );
    }

    return tokens;
  }

  private currentAccessToken(tokens: CodexTokens): string | undefined {
    const { access_token: accessToken, refresh_token: refreshToken, id_token: idToken } = tokens;

    const resolvedAccountId = extractAccountId(idToken, accessToken) || tokens.account_id;
    if (resolvedAccountId) {
      this.accountId = resolvedAccountId;
    }

    const expiryMs = getJwtExpiry(accessToken);
    const isExpiredOrSoon = expiryMs !== null && Date.now() + 5 * 60 * 1000 >= expiryMs;

    if (!isExpiredOrSoon) {
      return accessToken;
    }

    if (!refreshToken) {
      throw new ProviderReauthenticationRequiredError(
        tokens.imported
          ? 'The access token imported from the `codex` CLI has expired. Run `term2 --codex-login` so term2 holds its own credential.'
          : 'Codex access token is expired or expiring soon, but no refresh token is stored. Run `term2 --codex-login` again.',
      );
    }

    return undefined;
  }

  private async refreshAccessToken(tokens: CodexTokens): Promise<string> {
    const { refresh_token: refreshToken, id_token: idToken } = tokens;
    const response = await this.fetchImpl(CODEX_TOKEN_ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(this.refreshTimeoutMs),
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
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

    const newIdToken = resBody.id_token || idToken;
    const refreshedAccountId = extractAccountId(newIdToken, newAccessToken) || tokens.account_id;
    if (refreshedAccountId) {
      this.accountId = refreshedAccountId;
    }

    // Refresh the account this session is pinned to, not whichever the
    // user has since selected.
    const store = createCodexAccountStore(this.authPath);
    // Cross-process guard: single-use refresh_token — don't overwrite a
    // newer rotation already written by another term2 instance.
    const refreshTarget = this.pinnedAccountId;
    const current = refreshTarget
      ? (store.get(refreshTarget)?.tokens as CodexTokens | undefined)
      : (store.getActive()?.tokens as CodexTokens | undefined);
    // Signing out during an admitted rotation must not recreate the account.
    if (refreshTarget && !current) return newAccessToken;
    if (current?.refresh_token && current.refresh_token !== refreshToken) {
      return current.access_token;
    }
    const nextTokens = {
      access_token: newAccessToken,
      refresh_token: resBody.refresh_token || refreshToken,
      id_token: newIdToken,
      ...(refreshedAccountId ? { account_id: refreshedAccountId } : {}),
    };
    if (refreshTarget) store.updateTokens(refreshTarget, nextTokens);
    else store.updateActiveTokens(nextTokens);

    return newAccessToken;
  }
}
