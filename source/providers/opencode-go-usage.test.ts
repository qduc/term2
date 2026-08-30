import { describe, expect, it, vi } from 'vitest';
import { fetchOpenCodeGoUsage, OpenCodeGoUsageUnauthorizedError, parseOpenCodeGoUsage } from './opencode-go-usage.js';
const body = {
  useBalance: false,
  rollingUsage: { usagePercent: 42, resetInSec: 1234 },
  weeklyUsage: { usagePercent: 27, resetInSec: 345600 },
  monthlyUsage: { usagePercent: 18, resetInSec: 1414800 },
};
describe('OpenCode Go usage', () => {
  it('parses all three subscription limits', () => {
    expect(parseOpenCodeGoUsage(body)).toEqual(body);
  });
  it('rejects incomplete limits instead of reporting partial usage', () => {
    expect(parseOpenCodeGoUsage({ ...body, weeklyUsage: undefined })).toBeNull();
  });
  it('fetches the endpoint with the Go API key as a bearer token', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    await expect(fetchOpenCodeGoUsage({ apiKey: 'go-key', fetchImpl })).resolves.toEqual(body);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://opencode.ai/zen/go/v1/usage',
      expect.objectContaining({ headers: { authorization: 'Bearer go-key', accept: 'application/json' } }),
    );
  });
  it('classifies an unauthorized key', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 }));
    await expect(fetchOpenCodeGoUsage({ apiKey: 'bad', fetchImpl })).rejects.toBeInstanceOf(
      OpenCodeGoUsageUnauthorizedError,
    );
  });
});
