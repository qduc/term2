/**
 * Which OAuth account this process is actually authenticating as.
 *
 * The credential store records which account the user *selected*; that
 * selection applies to the next session. A running session stays pinned to
 * whichever account it resolved first, because provider response chaining is
 * bound to that identity. The two can therefore disagree, and the account
 * switcher has to show both — otherwise selecting an account looks like it did
 * nothing, or worse, like it took effect when it did not.
 *
 * Process-local and deliberately not persisted: it describes this run only.
 */
const sessionAccounts = new Map<string, string>();

export function recordSessionAccount(providerId: string, accountId: string): void {
  sessionAccounts.set(providerId, accountId);
}

export function getSessionAccount(providerId: string): string | null {
  return sessionAccounts.get(providerId) ?? null;
}

/** Test seam; production code never needs to forget a pin. */
export function resetSessionAccounts(): void {
  sessionAccounts.clear();
}
