import path from 'node:path';
/**
 * Which OAuth account one owning registry or token manager authenticates as.
 *
 * The credential store records which account the user *selected*; that
 * selection applies to the next session. A running session stays pinned to
 * whichever account it resolved first, because provider response chaining is
 * bound to that identity. The two can therefore disagree, and the account
 * switcher has to show both — otherwise selecting an account looks like it did
 * nothing, or worse, like it took effect when it did not.
 *
 * Owner-local and deliberately not persisted: callers supply the registry's store.
 */
export type SessionAccountStore = Map<string, string>;

/** A credential owner serializes refreshes of each account in a provider credential file.
 * Every waiter rereads its own account; token results are never shared. */
export class OAuthAccountRefreshCoordinator {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key);
    let release: () => void = () => {};
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

const refreshOwner = Symbol('oauthCredentialRefreshOwner');
type OwnedAccountStore = SessionAccountStore & { [refreshOwner]?: OAuthAccountRefreshCoordinator };

export function createSessionAccountStore(refreshes = new OAuthAccountRefreshCoordinator()): SessionAccountStore {
  const store = new Map<string, string>();
  Object.defineProperty(store, refreshOwner, { value: refreshes });
  return store;
}

export function withSessionAccountRefresh<T>(
  store: SessionAccountStore,
  providerId: string,
  credentialFile: string,
  accountId: string | null,
  operation: () => Promise<T>,
): Promise<T> {
  const owned = store as OwnedAccountStore;
  let refreshes = owned[refreshOwner];
  if (!refreshes) {
    refreshes = new OAuthAccountRefreshCoordinator();
    Object.defineProperty(owned, refreshOwner, { value: refreshes });
  }
  return refreshes.run(`${providerId}\0${path.resolve(credentialFile)}\0${accountId ?? 'cli'}`, operation);
}

export function recordSessionAccount(providerId: string, accountId: string, store: SessionAccountStore): void {
  store.set(providerId, accountId);
}

export function getSessionAccount(providerId: string, store: SessionAccountStore): string | null {
  return store.get(providerId) ?? null;
}

/** Test seam; production code never needs to forget a pin. */
export function resetSessionAccounts(store: SessionAccountStore): void {
  store.clear();
}

/** A caller may stop waiting while an admitted credential rotation persists safely.
 * Token-manager HTTP timeouts bound that work and release account admission. */
export function waitForSessionAccountRefresh<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
