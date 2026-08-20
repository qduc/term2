import { getActiveCodexAccount, listCodexAccounts, removeCodexAccount, setActiveCodexAccount } from './codex-auth.js';
import { getActiveGrokAccount, listGrokAccounts, removeGrokAccount, setActiveGrokAccount } from './grok-auth.js';

/**
 * The provider-neutral view of stored OAuth logins, so the account switcher UI
 * depends on one module instead of on each provider's credential file.
 *
 * Only providers term2 logs in to over OAuth appear here. API-key providers
 * hold one credential in settings and are managed by the existing key editor.
 */
export const OAUTH_ACCOUNT_PROVIDERS = ['codex', 'grok'] as const;
export type OAuthAccountProviderId = (typeof OAUTH_ACCOUNT_PROVIDERS)[number];

export type OAuthAccountSummary = {
  id: string;
  label: string;
  isActive: boolean;
};

export function isOAuthAccountProvider(providerId: string): providerId is OAuthAccountProviderId {
  return (OAUTH_ACCOUNT_PROVIDERS as readonly string[]).includes(providerId);
}

/** The command that adds another account for this provider. */
export function oauthLoginCommand(providerId: OAuthAccountProviderId): string {
  return providerId === 'codex' ? 'term2 --codex-login' : 'term2 --grok-login';
}

export function listOAuthAccounts(providerId: OAuthAccountProviderId): OAuthAccountSummary[] {
  const [accounts, active] =
    providerId === 'codex'
      ? [listCodexAccounts(), getActiveCodexAccount()]
      : [listGrokAccounts(), getActiveGrokAccount()];
  return accounts.map((account) => ({
    id: account.id,
    label: account.label,
    isActive: account.id === active?.id,
  }));
}

export function setActiveOAuthAccount(providerId: OAuthAccountProviderId, accountId: string): boolean {
  return providerId === 'codex' ? setActiveCodexAccount(accountId) : setActiveGrokAccount(accountId);
}

export function removeOAuthAccount(providerId: OAuthAccountProviderId, accountId: string): boolean {
  return providerId === 'codex' ? removeCodexAccount(accountId) : removeGrokAccount(accountId);
}
