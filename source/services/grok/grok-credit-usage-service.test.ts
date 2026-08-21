import { it, expect, vi } from 'vitest';
import {
  GrokCreditUsageService,
  GROK_CREDIT_USAGE_COOLDOWN_MS,
  getGrokCreditUsageService,
  resetGrokCreditUsageServiceForTests,
} from './grok-credit-usage-service.js';
import {
  GrokCreditUsageRateLimitedError,
  GrokCreditUsageUnauthorizedError,
  type GrokCreditUsage,
} from '../../providers/grok-credit-usage.js';

const usageAt = (percent: number): GrokCreditUsage => ({ creditUsagePercent: percent, productUsage: [] });

const makeService = (overrides: Parameters<typeof buildOptions>[0] = {}) => {
  const clock = { now: 1_000_000 };
  const options = buildOptions(overrides);
  const service = new GrokCreditUsageService({ ...options, now: () => clock.now });
  return { service, clock, fetchUsage: options.fetchUsage as unknown as ReturnType<typeof vi.fn> };
};

type FetchUsageMock = (options: { accessToken: string }) => Promise<GrokCreditUsage | null>;

function buildOptions(overrides: {
  fetchUsage?: FetchUsageMock;
  resolveAccessToken?: () => Promise<string | null>;
  resolveAccountId?: () => string | null;
  onError?: (error: unknown) => void;
}) {
  return {
    resolveAccessToken: overrides.resolveAccessToken ?? (async () => 'tok'),
    resolveAccountId: overrides.resolveAccountId,
    onError: overrides.onError,
    fetchUsage: (overrides.fetchUsage ?? vi.fn(async () => usageAt(29))) as FetchUsageMock,
  };
}

it('fetches on the first refresh and publishes the value', async () => {
  const { service, fetchUsage } = makeService();

  await service.refreshIfStale();

  expect(fetchUsage).toHaveBeenCalledTimes(1);
  expect(service.getSnapshot().usage?.creditUsagePercent).toBe(29);
  expect(service.getSnapshot().fetchedAtMs).toBe(1_000_000);
});

// The point of the cooldown: a rapid back-and-forth ends many turns in a short
// span, and each one asks to refresh.
it('skips refreshes inside the cooldown and resumes after it', async () => {
  const { service, clock, fetchUsage } = makeService();

  await service.refreshIfStale();
  clock.now += GROK_CREDIT_USAGE_COOLDOWN_MS - 1;
  await service.refreshIfStale();
  await service.refreshIfStale();
  expect(fetchUsage).toHaveBeenCalledTimes(1);

  clock.now += 1;
  await service.refreshIfStale();
  expect(fetchUsage).toHaveBeenCalledTimes(2);
});

it('force bypasses the cooldown for a manual refresh', async () => {
  const { service, fetchUsage } = makeService();

  await service.refreshIfStale();
  await service.refreshIfStale({ force: true });

  expect(fetchUsage).toHaveBeenCalledTimes(2);
});

// Without single-flight, a fan-out of subagents finishing together would each
// see an un-elapsed cooldown of its own and all fetch at once.
it('collapses concurrent refreshes into one request', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchUsage = vi.fn(async () => {
    await gate;
    return usageAt(29);
  });
  const { service } = makeService({ fetchUsage });

  const all = Promise.all([service.refreshIfStale(), service.refreshIfStale(), service.refreshIfStale()]);
  release();
  await all;

  expect(fetchUsage).toHaveBeenCalledTimes(1);
});

it('never rejects when the fetch fails', async () => {
  const fetchUsage = vi.fn(async () => {
    throw new Error('network down');
  });
  const onError = vi.fn();
  const { service } = makeService({ fetchUsage, onError });

  await expect(service.refreshIfStale()).resolves.toBeUndefined();
  expect(onError).toHaveBeenCalled();
});

it('keeps the last known value when a later fetch fails', async () => {
  const fetchUsage = vi
    .fn<() => Promise<GrokCreditUsage>>()
    .mockResolvedValueOnce(usageAt(29))
    .mockRejectedValueOnce(new Error('boom'));
  const { service, clock } = makeService({ fetchUsage });

  await service.refreshIfStale();
  clock.now += GROK_CREDIT_USAGE_COOLDOWN_MS;
  await service.refreshIfStale();

  expect(service.getSnapshot().usage?.creditUsagePercent).toBe(29);
});

it('backs off with doubling delays after repeated failures', async () => {
  const fetchUsage = vi.fn(async () => {
    throw new Error('boom');
  });
  const { service, clock } = makeService({ fetchUsage });

  await service.refreshIfStale();
  expect(fetchUsage).toHaveBeenCalledTimes(1);

  // First backoff step is a minute, shorter than the cooldown.
  clock.now += 59_000;
  await service.refreshIfStale();
  expect(fetchUsage).toHaveBeenCalledTimes(1);

  clock.now += 1_000;
  await service.refreshIfStale();
  expect(fetchUsage).toHaveBeenCalledTimes(2);

  // Second step doubles, so a minute is no longer enough.
  clock.now += 60_000;
  await service.refreshIfStale();
  expect(fetchUsage).toHaveBeenCalledTimes(2);

  clock.now += 60_000;
  await service.refreshIfStale();
  expect(fetchUsage).toHaveBeenCalledTimes(3);
});

it('resets the backoff after a success', async () => {
  const fetchUsage = vi
    .fn<() => Promise<GrokCreditUsage>>()
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValue(usageAt(30));
  const { service, clock } = makeService({ fetchUsage });

  await service.refreshIfStale();
  clock.now += 60_000;
  await service.refreshIfStale();
  expect(fetchUsage).toHaveBeenCalledTimes(2);

  // Back on the ordinary cooldown, not a doubled backoff.
  clock.now += GROK_CREDIT_USAGE_COOLDOWN_MS;
  await service.refreshIfStale();
  expect(fetchUsage).toHaveBeenCalledTimes(3);
});

// Retrying an endpoint that just said the token is dead gains nothing.
it('stops permanently once the credentials are rejected', async () => {
  const fetchUsage = vi.fn(async () => {
    throw new GrokCreditUsageUnauthorizedError();
  });
  const { service, clock } = makeService({ fetchUsage });

  await service.refreshIfStale();
  clock.now += 24 * 60 * 60 * 1000;
  await service.refreshIfStale();
  await service.refreshIfStale({ force: true });

  expect(fetchUsage).toHaveBeenCalledTimes(1);
});

it('resumes after a reset following rejected credentials', async () => {
  const fetchUsage = vi
    .fn<() => Promise<GrokCreditUsage>>()
    .mockRejectedValueOnce(new GrokCreditUsageUnauthorizedError())
    .mockResolvedValue(usageAt(5));
  const { service } = makeService({ fetchUsage });

  await service.refreshIfStale();
  service.reset();
  await service.refreshIfStale();

  expect(fetchUsage).toHaveBeenCalledTimes(2);
  expect(service.getSnapshot().usage?.creditUsagePercent).toBe(5);
});

it('honours retry-after when it exceeds the cooldown', async () => {
  const fetchUsage = vi.fn(async () => {
    throw new GrokCreditUsageRateLimitedError(20 * 60 * 1000);
  });
  const { service, clock } = makeService({ fetchUsage });

  await service.refreshIfStale();
  clock.now += 19 * 60 * 1000;
  await service.refreshIfStale();
  expect(fetchUsage).toHaveBeenCalledTimes(1);

  clock.now += 60 * 1000;
  await service.refreshIfStale();
  expect(fetchUsage).toHaveBeenCalledTimes(2);
});

// A 429 with a very short retry-after must not undercut our own cooldown.
it('never shortens the cooldown below its floor for a rate limit', async () => {
  const fetchUsage = vi.fn(async () => {
    throw new GrokCreditUsageRateLimitedError(1_000);
  });
  const { service, clock } = makeService({ fetchUsage });

  await service.refreshIfStale();
  clock.now += GROK_CREDIT_USAGE_COOLDOWN_MS - 1;
  await service.refreshIfStale();

  expect(fetchUsage).toHaveBeenCalledTimes(1);
});

it('waits out the cooldown without fetching when not logged in', async () => {
  const fetchUsage = vi.fn(async () => usageAt(29));
  const { service, clock } = makeService({ fetchUsage, resolveAccessToken: async () => null });

  await service.refreshIfStale();
  expect(fetchUsage).not.toHaveBeenCalled();
  expect(service.getSnapshot().usage).toBeNull();

  // A later login is still reachable: this is not a permanent stop.
  clock.now += GROK_CREDIT_USAGE_COOLDOWN_MS;
  await service.refreshIfStale();
  expect(fetchUsage).not.toHaveBeenCalled();
});

// One account's number is wrong for another, not merely stale.
it('drops the cached value when the resolved account changes', async () => {
  let accountId = 'account-a';
  const fetchUsage = vi
    .fn<() => Promise<GrokCreditUsage | null>>()
    .mockResolvedValueOnce(usageAt(29))
    .mockResolvedValueOnce(null);
  const { service, clock } = makeService({ fetchUsage, resolveAccountId: () => accountId });

  await service.refreshIfStale();
  expect(service.getSnapshot().usage?.creditUsagePercent).toBe(29);

  accountId = 'account-b';
  clock.now += GROK_CREDIT_USAGE_COOLDOWN_MS;
  await service.refreshIfStale();

  expect(service.getSnapshot().usage).toBeNull();
});

it('leaves the previous value alone when a response carries no meter', async () => {
  const fetchUsage = vi
    .fn<() => Promise<GrokCreditUsage | null>>()
    .mockResolvedValueOnce(usageAt(29))
    .mockResolvedValueOnce(null);
  const { service, clock } = makeService({ fetchUsage });

  await service.refreshIfStale();
  clock.now += GROK_CREDIT_USAGE_COOLDOWN_MS;
  await service.refreshIfStale();

  expect(service.getSnapshot().usage?.creditUsagePercent).toBe(29);
});

it('notifies subscribers when the value changes', async () => {
  const listener = vi.fn();
  const { service } = makeService();
  const unsubscribe = service.subscribe(listener);

  await service.refreshIfStale();
  expect(listener).toHaveBeenCalledTimes(1);

  unsubscribe();
  service.reset();
  expect(listener).toHaveBeenCalledTimes(1);
});

// The cooldown only holds if every caller consults the same clock.
it('shares one instance process-wide', () => {
  resetGrokCreditUsageServiceForTests();
  const first = getGrokCreditUsageService({ resolveAccessToken: async () => 'tok' });
  const second = getGrokCreditUsageService({ resolveAccessToken: async () => 'other' });

  expect(second).toBe(first);
  resetGrokCreditUsageServiceForTests();
});
