import { getActiveCodexAccount, listCodexAccounts, removeCodexAccount, setActiveCodexAccount } from './codex-auth.js';
import { getActiveGrokAccount, listGrokAccounts, removeGrokAccount, setActiveGrokAccount } from './grok-auth.js';
import { getSessionAccount } from './oauth-session-account.js';
/**
 * The provider-neutral view of stored OAuth logins, so the account switcher UI
 * depends on one module instead of on each provider's credential file.
 *
 * Only providers term2 logs in to over OAuth appear here. API-key providers
 * hold one credential in settings and are managed by the existing key editor.
 */
export const OAUTH_ACCOUNT_PROVIDERS = ['codex', 'grok'];
export function isOAuthAccountProvider(providerId) {
    return OAUTH_ACCOUNT_PROVIDERS.includes(providerId);
}
/** The command that adds another account for this provider. */
export function oauthLoginCommand(providerId) {
    return providerId === 'codex' ? 'term2 --codex-login' : 'term2 --grok-login';
}
export function listOAuthAccounts(providerId) {
    const [accounts, active] = providerId === 'codex'
        ? [listCodexAccounts(), getActiveCodexAccount()]
        : [listGrokAccounts(), getActiveGrokAccount()];
    const inUse = getSessionAccount(providerId);
    return accounts.map((account) => ({
        id: account.id,
        label: account.label,
        isSelected: account.id === active?.id,
        isInUse: account.id === inUse,
    }));
}
export function setActiveOAuthAccount(providerId, accountId) {
    return providerId === 'codex' ? setActiveCodexAccount(accountId) : setActiveGrokAccount(accountId);
}
export function removeOAuthAccount(providerId, accountId) {
    return providerId === 'codex' ? removeCodexAccount(accountId) : removeGrokAccount(accountId);
}
//# sourceMappingURL=oauth-accounts.js.map