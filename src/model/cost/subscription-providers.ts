/**
 * Providers reached through a subscription rather than metered per-token billing.
 *
 * Their requests are unpriced because no per-token rate applies at all, not
 * because a rate is missing from the catalog. Counting their tokens as a spend
 * proxy measures nothing: the subscription is already paid, and its real meter
 * is a separate allowance (Grok's weekly credit percentage, Codex's rate-limit
 * windows), which the status bar surfaces on its own.
 */
const SUBSCRIPTION_PROVIDERS = new Set(['grok', 'codex']);

export function isSubscriptionProvider(provider: string | undefined): boolean {
  return provider !== undefined && SUBSCRIPTION_PROVIDERS.has(provider.trim().toLowerCase());
}
