/**
 * Providers reached through a subscription rather than metered per-token billing.
 *
 * Catalog rates are not subscription spend: the real meter is a separate
 * allowance (Grok's weekly credit percentage, Codex's rate-limit windows).
 * Reference comparisons are computed separately and do not enter budgets.
 */
const SUBSCRIPTION_PROVIDERS = new Set(['grok', 'codex']);

export function isSubscriptionProvider(provider: string | undefined): boolean {
  return provider !== undefined && SUBSCRIPTION_PROVIDERS.has(provider.trim().toLowerCase());
}
