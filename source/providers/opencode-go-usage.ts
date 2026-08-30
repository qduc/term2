/** Usage meter for the OpenCode Go subscription. */
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
export interface OpenCodeGoUsageLimit {
  readonly usagePercent: number;
  readonly resetInSec: number;
}
export interface OpenCodeGoUsage {
  readonly useBalance: boolean;
  readonly rollingUsage: OpenCodeGoUsageLimit;
  readonly weeklyUsage: OpenCodeGoUsageLimit;
  readonly monthlyUsage: OpenCodeGoUsageLimit;
}
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const asNonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const parseLimit = (value: unknown): OpenCodeGoUsageLimit | undefined => {
  const record = asRecord(value);
  const usagePercent = asNonNegativeNumber(record?.usagePercent);
  const resetInSec = asNonNegativeNumber(record?.resetInSec);
  return usagePercent !== undefined && resetInSec !== undefined ? { usagePercent, resetInSec } : undefined;
};
export const parseOpenCodeGoUsage = (body: unknown): OpenCodeGoUsage | null => {
  const record = asRecord(body);
  const rollingUsage = parseLimit(record?.rollingUsage);
  const weeklyUsage = parseLimit(record?.weeklyUsage);
  const monthlyUsage = parseLimit(record?.monthlyUsage);
  if (!rollingUsage || !weeklyUsage || !monthlyUsage) return null;
  return { useBalance: record?.useBalance === true, rollingUsage, weeklyUsage, monthlyUsage };
};
export class OpenCodeGoUsageUnauthorizedError extends Error {
  constructor() {
    super('OpenCode rejected the credentials for the Go usage endpoint.');
    this.name = 'OpenCodeGoUsageUnauthorizedError';
  }
}
export interface FetchOpenCodeGoUsageOptions {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly url?: string;
  readonly signal?: AbortSignal;
}
export const fetchOpenCodeGoUsage = async ({
  apiKey,
  fetchImpl = globalThis.fetch,
  url = OPENCODE_GO_USAGE_URL,
  signal,
}: FetchOpenCodeGoUsageOptions): Promise<OpenCodeGoUsage | null> => {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (response.status === 401 || response.status === 403) throw new OpenCodeGoUsageUnauthorizedError();
  if (!response.ok) throw new Error(`OpenCode Go usage request failed with HTTP ${response.status}.`);
  return parseOpenCodeGoUsage(await response.json());
};
