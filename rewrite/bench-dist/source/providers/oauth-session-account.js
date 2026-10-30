export function createSessionAccountStore() {
    return new Map();
}
const sessionAccounts = createSessionAccountStore();
export function recordSessionAccount(providerId, accountId, store = sessionAccounts) {
    store.set(providerId, accountId);
}
export function getSessionAccount(providerId, store = sessionAccounts) {
    return store.get(providerId) ?? null;
}
/** Test seam; production code never needs to forget a pin. */
export function resetSessionAccounts() {
    sessionAccounts.clear();
}
//# sourceMappingURL=oauth-session-account.js.map