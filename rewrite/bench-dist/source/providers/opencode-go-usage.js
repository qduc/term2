/** Usage meter for the OpenCode Go subscription. */
const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const asRecord = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
const asNonNegativeNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const parseLimit = (value) => {
    const record = asRecord(value);
    const usagePercent = asNonNegativeNumber(record?.usagePercent);
    const resetInSec = asNonNegativeNumber(record?.resetInSec);
    return usagePercent !== undefined && resetInSec !== undefined ? { usagePercent, resetInSec } : undefined;
};
export const parseOpenCodeGoUsage = (body) => {
    const record = asRecord(body);
    const rollingUsage = parseLimit(record?.rollingUsage);
    const weeklyUsage = parseLimit(record?.weeklyUsage);
    const monthlyUsage = parseLimit(record?.monthlyUsage);
    if (!rollingUsage || !weeklyUsage || !monthlyUsage)
        return null;
    return { useBalance: record?.useBalance === true, rollingUsage, weeklyUsage, monthlyUsage };
};
export class OpenCodeGoUsageUnauthorizedError extends Error {
    constructor() {
        super('OpenCode rejected the credentials for the Go usage endpoint.');
        this.name = 'OpenCodeGoUsageUnauthorizedError';
    }
}
export const fetchOpenCodeGoUsage = async ({ apiKey, fetchImpl = globalThis.fetch, url = OPENCODE_GO_USAGE_URL, signal, }) => {
    const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        ...(signal ? { signal } : {}),
    });
    if (response.status === 401 || response.status === 403)
        throw new OpenCodeGoUsageUnauthorizedError();
    if (!response.ok)
        throw new Error(`OpenCode Go usage request failed with HTTP ${response.status}.`);
    return parseOpenCodeGoUsage(await response.json());
};
//# sourceMappingURL=opencode-go-usage.js.map