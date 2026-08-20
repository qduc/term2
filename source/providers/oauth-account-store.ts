import fs from 'node:fs';
import path from 'node:path';

/**
 * A multi-account credential store, shared by every provider term2 logs in to
 * over OAuth.
 *
 * One file holds several accounts and a pointer to the active one. Each account
 * owns its own refresh token, and refreshes are written back to that account
 * only — accounts never share a rotation chain, which is the same hazard that
 * made us stop sharing files with the `grok` and `codex` CLIs in the first
 * place (docs/plans/provider-oauth-independence.md).
 */
export const OAUTH_ACCOUNT_STORE_VERSION = 2;

export type OAuthAccount<TTokens> = {
  /** Stable within a provider; derived from the credential, not the login order. */
  id: string;
  /** What the user sees in the switcher, e.g. an email address. */
  label: string;
  tokens: TTokens;
  addedAt: string;
};

export type OAuthAccountStoreFile<TTokens> = {
  version: number;
  activeAccountId: string | null;
  accounts: OAuthAccount<TTokens>[];
};

export type AccountIdentity = { id: string; label: string };

export type OAuthAccountStoreOptions<TTokens> = {
  /** Absolute path to this provider's credential file. */
  filePath: string;
  /**
   * Names an account from its credential. Two logins to the same account must
   * produce the same id, or switching would accumulate duplicates.
   */
  identify: (tokens: TTokens) => AccountIdentity;
  /**
   * Reads a pre-multi-account (v1) file body into tokens, so an existing login
   * survives the upgrade instead of silently logging the user out. Return null
   * if the body holds no usable credential.
   */
  migrateLegacy: (body: unknown) => TTokens | null;
};

function emptyStore<TTokens>(): OAuthAccountStoreFile<TTokens> {
  return { version: OAUTH_ACCOUNT_STORE_VERSION, activeAccountId: null, accounts: [] };
}

export class OAuthAccountStore<TTokens> {
  constructor(private readonly options: OAuthAccountStoreOptions<TTokens>) {}

  get filePath(): string {
    return this.options.filePath;
  }

  /**
   * Reads the store, upgrading a v1 single-credential file in memory. The
   * upgrade is not written back until something else writes, so merely reading
   * a credential never rewrites it.
   */
  read(): OAuthAccountStoreFile<TTokens> {
    let parsed: any;
    try {
      parsed = JSON.parse(fs.readFileSync(this.options.filePath, 'utf8'));
    } catch {
      return emptyStore<TTokens>();
    }

    if (parsed && Array.isArray(parsed.accounts)) {
      const accounts = parsed.accounts.filter(
        (account: any) => account && typeof account.id === 'string' && account.tokens,
      ) as OAuthAccount<TTokens>[];
      const activeAccountId =
        typeof parsed.activeAccountId === 'string' && accounts.some((a) => a.id === parsed.activeAccountId)
          ? parsed.activeAccountId
          : accounts[0]?.id ?? null;
      return { version: OAUTH_ACCOUNT_STORE_VERSION, activeAccountId, accounts };
    }

    const legacy = this.options.migrateLegacy(parsed);
    if (!legacy) return emptyStore<TTokens>();
    const identity = this.options.identify(legacy);
    return {
      version: OAUTH_ACCOUNT_STORE_VERSION,
      activeAccountId: identity.id,
      accounts: [{ ...identity, tokens: legacy, addedAt: new Date().toISOString() }],
    };
  }

  private write(store: OAuthAccountStoreFile<TTokens>): void {
    fs.mkdirSync(path.dirname(this.options.filePath), { recursive: true });
    const tmpPath = `${this.options.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600, encoding: 'utf8' });
    fs.renameSync(tmpPath, this.options.filePath);
  }

  list(): OAuthAccount<TTokens>[] {
    return this.read().accounts;
  }

  getActive(): OAuthAccount<TTokens> | null {
    const store = this.read();
    return store.accounts.find((account) => account.id === store.activeAccountId) ?? null;
  }

  getActiveTokens(): TTokens | null {
    return this.getActive()?.tokens ?? null;
  }

  /**
   * Adds a freshly logged-in account, or replaces the credential of one already
   * present, and makes it active. Re-logging in to an existing account replaces
   * its tokens rather than adding a duplicate.
   */
  upsert(tokens: TTokens): OAuthAccount<TTokens> {
    const store = this.read();
    const identity = this.options.identify(tokens);
    const existing = store.accounts.find((account) => account.id === identity.id);
    const account: OAuthAccount<TTokens> = existing
      ? { ...existing, label: identity.label, tokens }
      : { ...identity, tokens, addedAt: new Date().toISOString() };

    const accounts = existing
      ? store.accounts.map((candidate) => (candidate.id === identity.id ? account : candidate))
      : [...store.accounts, account];

    this.write({ version: OAUTH_ACCOUNT_STORE_VERSION, activeAccountId: identity.id, accounts });
    return account;
  }

  /**
   * Replaces the active account's credential in place, for a token refresh.
   * Refreshing must not change which account is active, and must not touch any
   * other account's rotation chain.
   */
  updateActiveTokens(tokens: TTokens): void {
    const store = this.read();
    if (!store.activeAccountId) {
      this.upsert(tokens);
      return;
    }
    this.write({
      ...store,
      accounts: store.accounts.map((account) =>
        account.id === store.activeAccountId ? { ...account, tokens } : account,
      ),
    });
  }

  /** Returns false when the id names no stored account. */
  setActive(accountId: string): boolean {
    const store = this.read();
    if (!store.accounts.some((account) => account.id === accountId)) return false;
    this.write({ ...store, activeAccountId: accountId });
    return true;
  }

  /**
   * Forgets an account. If it was the active one, the next remaining account
   * takes over so the provider does not silently become unusable.
   */
  remove(accountId: string): boolean {
    const store = this.read();
    if (!store.accounts.some((account) => account.id === accountId)) return false;
    const accounts = store.accounts.filter((account) => account.id !== accountId);
    const activeAccountId = store.activeAccountId === accountId ? accounts[0]?.id ?? null : store.activeAccountId;
    this.write({ version: OAUTH_ACCOUNT_STORE_VERSION, activeAccountId, accounts });
    return true;
  }
}
