import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
/**
 * A multi-account credential store, shared by every provider term2 logs in to
 * over OAuth.
 *
 * One file holds several accounts and a pointer to the active one. Each account
 * owns its own refresh token, and refreshes are written back to that account
 * only — accounts never share a rotation chain, which is the same hazard that
 * made us stop sharing files with the `grok` and `codex` CLIs in the first
 * place (docs/plans/providers/provider-oauth-independence.md).
 */
const OAUTH_ACCOUNT_STORE_VERSION = 2;
function emptyStore() {
    return { version: OAUTH_ACCOUNT_STORE_VERSION, activeAccountId: null, accounts: [] };
}
export class OAuthAccountStore {
    options;
    filesystem;
    constructor(options) {
        this.options = options;
        this.filesystem = options.filesystem ?? fs;
        this.sweepTemporaryFiles();
    }
    get filePath() {
        return this.options.filePath;
    }
    /**
     * Reads the store, upgrading a v1 single-credential file in memory. The
     * upgrade is not written back until something else writes, so merely reading
     * a credential never rewrites it.
     */
    read() {
        let parsed;
        try {
            parsed = JSON.parse(this.filesystem.readFileSync(this.options.filePath, 'utf8'));
        }
        catch {
            return emptyStore();
        }
        if (parsed && Array.isArray(parsed.accounts)) {
            const accounts = parsed.accounts.filter((account) => account && typeof account.id === 'string' && account.tokens);
            const activeAccountId = typeof parsed.activeAccountId === 'string' && accounts.some((a) => a.id === parsed.activeAccountId)
                ? parsed.activeAccountId
                : accounts[0]?.id ?? null;
            return { version: OAUTH_ACCOUNT_STORE_VERSION, activeAccountId, accounts };
        }
        const legacy = this.options.migrateLegacy(parsed);
        if (!legacy)
            return emptyStore();
        const identity = this.options.identify(legacy);
        return {
            version: OAUTH_ACCOUNT_STORE_VERSION,
            activeAccountId: identity.id,
            accounts: [{ ...identity, tokens: legacy, addedAt: new Date().toISOString() }],
        };
    }
    write(store) {
        this.filesystem.mkdirSync(path.dirname(this.options.filePath), { recursive: true });
        const tmpPath = `${this.options.filePath}.${process.pid}.${randomUUID()}.tmp`;
        let fd;
        let renamed = false;
        try {
            fd = this.filesystem.openSync(tmpPath, 'w', 0o600);
            this.filesystem.writeFileSync(fd, JSON.stringify(store, null, 2), { encoding: 'utf8' });
            this.filesystem.fsyncSync(fd);
            this.filesystem.closeSync(fd);
            fd = undefined;
            this.filesystem.renameSync(tmpPath, this.options.filePath);
            renamed = true;
        }
        finally {
            if (fd !== undefined) {
                try {
                    this.filesystem.closeSync(fd);
                }
                catch {
                    // Preserve the original write failure.
                }
            }
            if (!renamed) {
                try {
                    this.filesystem.unlinkSync(tmpPath);
                }
                catch {
                    // Best-effort cleanup; the next startup sweep retries it.
                }
            }
        }
    }
    sweepTemporaryFiles() {
        const directory = path.dirname(this.options.filePath);
        const base = path.basename(this.options.filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const unique = new RegExp(`^${base}\\.[^.]+\\.[A-Fa-f0-9-]{36}\\.tmp$`);
        try {
            for (const name of this.filesystem.readdirSync(directory)) {
                if (name === `${path.basename(this.options.filePath)}.tmp` || unique.test(name)) {
                    try {
                        this.filesystem.unlinkSync(path.join(directory, name));
                    }
                    catch {
                        // A concurrent writer or permission failure is handled on its own path.
                    }
                }
            }
        }
        catch {
            // A missing store directory has no temporary credentials to recover.
        }
    }
    list() {
        return this.read().accounts;
    }
    get(accountId) {
        return this.read().accounts.find((account) => account.id === accountId) ?? null;
    }
    getActive() {
        const store = this.read();
        return store.accounts.find((account) => account.id === store.activeAccountId) ?? null;
    }
    getActiveTokens() {
        return this.getActive()?.tokens ?? null;
    }
    /**
     * Adds a freshly logged-in account, or replaces the credential of one already
     * present, and makes it active. Re-logging in to an existing account replaces
     * its tokens rather than adding a duplicate.
     */
    upsert(tokens) {
        const store = this.read();
        const identity = this.options.identify(tokens);
        const existing = store.accounts.find((account) => account.id === identity.id);
        const account = existing
            ? { ...existing, label: identity.label, tokens }
            : { ...identity, tokens, addedAt: new Date().toISOString() };
        const accounts = existing
            ? store.accounts.map((candidate) => (candidate.id === identity.id ? account : candidate))
            : [...store.accounts, account];
        this.write({ version: OAUTH_ACCOUNT_STORE_VERSION, activeAccountId: identity.id, accounts });
        return account;
    }
    /**
     * Replaces one account's credential in place, for a token refresh.
     *
     * The account is named explicitly rather than taken from the active pointer,
     * because a running session stays pinned to the account it started with even
     * after the user selects a different one. Refreshing must not change which
     * account is active, and must not touch any other account's rotation chain.
     */
    updateTokens(accountId, tokens) {
        const store = this.read();
        if (!store.accounts.some((account) => account.id === accountId)) {
            this.upsert(tokens);
            return;
        }
        this.write({
            ...store,
            accounts: store.accounts.map((account) => (account.id === accountId ? { ...account, tokens } : account)),
        });
    }
    /** Convenience for the common case of refreshing whatever is active. */
    updateActiveTokens(tokens) {
        const store = this.read();
        if (!store.activeAccountId) {
            this.upsert(tokens);
            return;
        }
        this.updateTokens(store.activeAccountId, tokens);
    }
    /** Returns false when the id names no stored account. */
    setActive(accountId) {
        const store = this.read();
        if (!store.accounts.some((account) => account.id === accountId))
            return false;
        this.write({ ...store, activeAccountId: accountId });
        return true;
    }
    /**
     * Forgets an account. If it was the active one, the next remaining account
     * takes over so the provider does not silently become unusable.
     */
    remove(accountId) {
        const store = this.read();
        if (!store.accounts.some((account) => account.id === accountId))
            return false;
        const accounts = store.accounts.filter((account) => account.id !== accountId);
        const activeAccountId = store.activeAccountId === accountId ? accounts[0]?.id ?? null : store.activeAccountId;
        this.write({ version: OAUTH_ACCOUNT_STORE_VERSION, activeAccountId, accounts });
        return true;
    }
}
//# sourceMappingURL=oauth-account-store.js.map