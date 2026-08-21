import { it, expect, vi } from 'vitest';
import {
  fetchGrokCreditUsage,
  parseGrokCreditUsage,
  GrokCreditUsageRateLimitedError,
  GrokCreditUsageUnauthorizedError,
} from './grok-credit-usage.js';

// The shape recorded from the live proxy on 2026-08-21.
const LIVE_BODY = {
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-08-17T06:13:52.080889+00:00',
      end: '2026-08-24T06:13:52.080889+00:00',
    },
    creditUsagePercent: 29.0,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [
      { product: 'GrokBuild', usagePercent: 19.0 },
      { product: 'GrokImagine', usagePercent: 9.0 },
      { product: 'GrokChat', usagePercent: 1.0 },
    ],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    billingPeriodStart: '2026-08-17T06:13:52.080889+00:00',
    billingPeriodEnd: '2026-08-24T06:13:52.080889+00:00',
  },
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

it('parses the live credits response', () => {
  const usage = parseGrokCreditUsage(LIVE_BODY);

  expect(usage?.creditUsagePercent).toBe(29);
  expect(usage?.periodEndMs).toBe(Date.parse('2026-08-24T06:13:52.080889+00:00'));
  expect(usage?.productUsage).toEqual([
    { product: 'GrokBuild', usagePercent: 19 },
    { product: 'GrokImagine', usagePercent: 9 },
    { product: 'GrokChat', usagePercent: 1 },
  ]);
});

// Showing 0% when we failed to read the number would misreport the account as
// unused; no data must stay no data.
it('returns null rather than zero when the percentage is missing', () => {
  expect(parseGrokCreditUsage({ config: { currentPeriod: { end: '2026-08-24T00:00:00Z' } } })).toBeNull();
  expect(parseGrokCreditUsage({ config: {} })).toBeNull();
  expect(parseGrokCreditUsage({})).toBeNull();
  expect(parseGrokCreditUsage(null)).toBeNull();
});

// The period and the split are presentation extras; a body without them still
// carries the number worth showing.
it('parses a response carrying only the percentage', () => {
  const usage = parseGrokCreditUsage({ config: { creditUsagePercent: 4 } });

  expect(usage).toEqual({ creditUsagePercent: 4, productUsage: [] });
});

it('falls back to billingPeriodEnd when currentPeriod is absent', () => {
  const usage = parseGrokCreditUsage({
    config: { creditUsagePercent: 4, billingPeriodEnd: '2026-09-01T00:00:00+00:00' },
  });

  expect(usage?.periodEndMs).toBe(Date.parse('2026-09-01T00:00:00+00:00'));
});

it('requests the credits format with a bearer token', async () => {
  const fetchImpl = vi.fn(async () => jsonResponse(LIVE_BODY)) as unknown as typeof fetch;

  const usage = await fetchGrokCreditUsage({ accessToken: 'tok', fetchImpl, baseUrl: 'https://example.test/v1' });

  expect(usage?.creditUsagePercent).toBe(29);
  const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(url).toBe('https://example.test/v1/billing?format=credits');
  expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' });
});

// A dead token must be distinguishable from a transient failure, because the
// service stops polling on one and backs off on the other.
it('throws an unauthorized error for 401 and 403', async () => {
  for (const status of [401, 403]) {
    const fetchImpl = (async () => jsonResponse({ error: 'nope' }, status)) as unknown as typeof fetch;
    await expect(fetchGrokCreditUsage({ accessToken: 'tok', fetchImpl })).rejects.toBeInstanceOf(
      GrokCreditUsageUnauthorizedError,
    );
  }
});

it('carries retry-after out of a 429', async () => {
  const fetchImpl = (async () =>
    new Response('{}', { status: 429, headers: { 'retry-after': '120' } })) as unknown as typeof fetch;

  await expect(fetchGrokCreditUsage({ accessToken: 'tok', fetchImpl })).rejects.toMatchObject({
    name: 'GrokCreditUsageRateLimitedError',
    retryAfterMs: 120_000,
  });
});

it('throws for other failing statuses', async () => {
  const fetchImpl = (async () => jsonResponse({}, 500)) as unknown as typeof fetch;

  await expect(fetchGrokCreditUsage({ accessToken: 'tok', fetchImpl })).rejects.toThrow('HTTP 500');
});

it('does not classify a server error as rate limiting', async () => {
  const fetchImpl = (async () => jsonResponse({}, 503)) as unknown as typeof fetch;

  await expect(fetchGrokCreditUsage({ accessToken: 'tok', fetchImpl })).rejects.not.toBeInstanceOf(
    GrokCreditUsageRateLimitedError,
  );
});
