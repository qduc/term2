/**
 * Reads Grok's credit-usage meter — the number the official `grok` CLI shows
 * under `/usage`.
 *
 * This does not come from the inference lane. Grok's Responses stream carries
 * no quota frame (unlike Codex, which pushes `codex.rate_limits` mid-stream),
 * and the proxy returns no rate-limit response headers. The meter lives behind
 * a separate REST call on the same host, and nothing fetches it unless we ask.
 *
 * Endpoint and shape were established against the live proxy on 2026-08-21:
 * a bearer token alone is accepted, `?format=credits` selects the weekly
 * percentage view (omitting it returns monthly billing totals instead), and an
 * unauthenticated call returns a clean 401.
 */
import { GROK_BASE_URL } from './grok.provider.js';
const asRecord = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
const asFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const parseTimestampMs = (value) => {
    if (typeof value !== 'string' || !value)
        return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
};
const parseProductUsage = (value) => {
    if (!Array.isArray(value))
        return [];
    const parsed = [];
    for (const entry of value) {
        const record = asRecord(entry);
        const usagePercent = asFiniteNumber(record?.usagePercent);
        const product = typeof record?.product === 'string' ? record.product : undefined;
        if (product && usagePercent !== undefined)
            parsed.push({ product, usagePercent });
    }
    return parsed;
};
/**
 * Extracts the meter from a `?format=credits` body, or returns null when the
 * response doesn't carry one.
 *
 * `creditUsagePercent` is the only required field: the period and the product
 * split are presentation extras, and a body missing them is still worth
 * showing. A body missing the percentage is not, so it is treated as no data
 * rather than as zero usage — reporting 0% when we simply failed to read the
 * number would be worse than showing nothing.
 */
export const parseGrokCreditUsage = (body) => {
    const config = asRecord(asRecord(body)?.config);
    if (!config)
        return null;
    const creditUsagePercent = asFiniteNumber(config.creditUsagePercent);
    if (creditUsagePercent === undefined)
        return null;
    const currentPeriod = asRecord(config.currentPeriod);
    const periodEndMs = parseTimestampMs(currentPeriod?.end) ?? parseTimestampMs(config.billingPeriodEnd);
    return {
        creditUsagePercent,
        ...(periodEndMs !== undefined ? { periodEndMs } : {}),
        productUsage: parseProductUsage(config.productUsage),
    };
};
/** Raised when the provider rejects the token, so the caller can stop asking. */
export class GrokCreditUsageUnauthorizedError extends Error {
    constructor() {
        super('Grok rejected the credentials for the credit-usage endpoint.');
        this.name = 'GrokCreditUsageUnauthorizedError';
    }
}
/** Raised when the provider asks us to back off, carrying its own delay. */
export class GrokCreditUsageRateLimitedError extends Error {
    retryAfterMs;
    constructor(retryAfterMs) {
        super('Grok rate-limited the credit-usage endpoint.');
        this.name = 'GrokCreditUsageRateLimitedError';
        this.retryAfterMs = retryAfterMs;
    }
}
const parseRetryAfterMs = (value) => {
    if (!value)
        return undefined;
    const seconds = Number(value.trim());
    if (Number.isFinite(seconds) && seconds >= 0)
        return seconds * 1000;
    const dateMs = Date.parse(value.trim());
    return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
};
/**
 * Fetches the credit meter. Returns null when the response is well-formed but
 * carries no meter; throws for transport and status failures so the caller can
 * distinguish "nothing to show" from "ask again later".
 */
export const fetchGrokCreditUsage = async ({ accessToken, fetchImpl = globalThis.fetch, baseUrl = GROK_BASE_URL, signal, }) => {
    const response = await fetchImpl(`${baseUrl}/billing?format=credits`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        ...(signal ? { signal } : {}),
    });
    if (response.status === 401 || response.status === 403) {
        throw new GrokCreditUsageUnauthorizedError();
    }
    if (response.status === 429) {
        throw new GrokCreditUsageRateLimitedError(parseRetryAfterMs(response.headers.get('retry-after')));
    }
    if (!response.ok) {
        throw new Error(`Grok credit-usage request failed with HTTP ${response.status}.`);
    }
    return parseGrokCreditUsage(await response.json());
};
//# sourceMappingURL=grok-credit-usage.js.map