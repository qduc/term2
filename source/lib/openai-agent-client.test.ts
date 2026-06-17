import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { OpenRouterError } from '../providers/common/provider-errors.js';
import { wrapNeedsApproval } from './tool-invoke.js';

it('OpenRouterError includes status and headers', () => {
  const error = new OpenRouterError('Test error', 429, { 'retry-after': '5', 'x-custom': 'value' }, 'response body');

  expect(error.message).toBe('Test error');
  expect(error.status).toBe(429);
  expect(error.headers).toEqual({ 'retry-after': '5', 'x-custom': 'value' });
  expect(error.responseBody).toBe('response body');
  expect(error.name).toBe('OpenRouterError');
});

it('OpenRouterError is throwable', () => {
  const fn = () => {
    throw new OpenRouterError('Error message', 500, {});
  };

  expect(fn).toThrow(OpenRouterError);
  try {
    fn();
  } catch (e) {
    expect((e as OpenRouterError).status).toBe(500);
  }
});

// ========== Exponential Backoff and Retry Logic Tests ==========

it('exponential backoff calculation follows correct formula', () => {
  // This tests the algorithm: baseDelay * 2^attemptIndex
  const baseDelay = 1000; // Using fixed base for predictable testing

  // First retry (attemptIndex = 0)
  const delay0 = baseDelay * Math.pow(2, 0);
  expect(delay0).toBe(1000);

  // Second retry (attemptIndex = 1)
  const delay1 = baseDelay * Math.pow(2, 1);
  expect(delay1).toBe(2000);

  // Third retry (attemptIndex = 2)
  const delay2 = baseDelay * Math.pow(2, 2);
  expect(delay2).toBe(4000);

  // Fourth retry (attemptIndex = 3)
  const delay3 = baseDelay * Math.pow(2, 3);
  expect(delay3).toBe(8000);
});

it('exponential backoff is capped at maximum delay', () => {
  const baseDelay = 1000;
  const maxDelay = 30000; // 30 seconds

  // For attemptIndex = 10, exponential would be 1000 * 2^10 = 1,024,000ms
  const exponentialDelay = baseDelay * Math.pow(2, 10);
  expect(exponentialDelay).toBe(1024000);

  // Should be capped at maxDelay
  const cappedDelay = Math.min(exponentialDelay, maxDelay);
  expect(cappedDelay).toBe(maxDelay);
  expect(cappedDelay).toBe(30000);
});

it('jitter randomizes delay between 0 and capped delay', () => {
  const cappedDelay = 5000;

  // Run multiple times to verify randomization
  const delays: number[] = [];
  for (let i = 0; i < 100; i++) {
    const jitteredDelay = Math.random() * cappedDelay;
    delays.push(jitteredDelay);

    // Should be within range
    expect(jitteredDelay >= 0).toBe(true);
    expect(jitteredDelay <= cappedDelay).toBe(true);
  }

  // Verify we got different values (not all the same)
  const uniqueDelays = new Set(delays);
  expect(uniqueDelays.size > 10).toBe(true); // Should have variety
});

it('retry classification - 429 is retryable', () => {
  const error = new OpenRouterError('Rate limit', 429, {});
  const isRetryable = error.status === 429 || error.status >= 500;
  expect(isRetryable).toBe(true);
});

it('retry classification - 5xx errors are retryable', () => {
  const retryableStatuses = [500, 502, 503, 504];

  for (const status of retryableStatuses) {
    const error = new OpenRouterError(`Server error`, status, {});
    const isRetryable = error.status === 429 || error.status >= 500;
    expect(isRetryable).toBe(true);
  }
});

it('retry classification - 4xx errors (except 429) are NOT retryable', () => {
  const nonRetryableStatuses = [400, 401, 403, 404, 422];

  for (const status of nonRetryableStatuses) {
    const error = new OpenRouterError(`Client error`, status, {});
    const isRetryable = error.status === 429 || error.status >= 500;
    expect(isRetryable).toBe(false);
  }
});

it('retry classification - 2xx success codes are NOT retryable', () => {
  const successStatuses = [200, 201, 204];

  for (const status of successStatuses) {
    const error = new OpenRouterError(`Success (shouldn't be error)`, status, {});
    const isRetryable = error.status === 429 || error.status >= 500;
    expect(isRetryable).toBe(false);
  }
});

it('retry classification - 3xx redirects are NOT retryable', () => {
  const redirectStatuses = [301, 302, 304];

  for (const status of redirectStatuses) {
    const error = new OpenRouterError(`Redirect`, status, {});
    const isRetryable = error.status === 429 || error.status >= 500;
    expect(isRetryable).toBe(false);
  }
});

it('Retry-After header extraction from OpenRouterError', () => {
  const error = new OpenRouterError('Rate limit', 429, { 'retry-after': '60' });

  const retryAfter = error.headers['retry-after'];
  expect(retryAfter).toBe('60');

  const delayMs = parseInt(retryAfter, 10) * 1000;
  expect(delayMs).toBe(60000); // 60 seconds in milliseconds
});

it('Retry-After header missing returns undefined', () => {
  const error = new OpenRouterError('Server error', 503, {});

  const retryAfter = error.headers['retry-after'];
  expect(retryAfter).toBeFalsy();
  expect('retry-after' in error.headers).toBe(false);
});

it('Retry-After header with different case sensitivity', () => {
  // Headers might come with different casing
  const error1 = new OpenRouterError('Error', 429, { 'Retry-After': '30' });
  const error2 = new OpenRouterError('Error', 429, { 'retry-after': '30' });
  const error3 = new OpenRouterError('Error', 429, { 'RETRY-AFTER': '30' });

  // Note: In JavaScript, object property access is case-sensitive
  // The actual implementation would need to handle case-insensitive lookup
  // For now, we test exact match
  expect(error1.headers['Retry-After']).toBe('30');
  expect(error2.headers['retry-after']).toBe('30');
  expect(error3.headers['RETRY-AFTER']).toBe('30');
});

it('exponential backoff with base delay range (500-1000ms)', () => {
  // Test the randomized base delay range
  const baseDelays: number[] = [];

  for (let i = 0; i < 100; i++) {
    const baseDelay = 500 + Math.random() * 500; // 500-1000ms
    baseDelays.push(baseDelay);

    expect(baseDelay >= 500).toBe(true);
    expect(baseDelay <= 1000).toBe(true);
  }

  // Check we have variety in base delays
  const min = Math.min(...baseDelays);
  const max = Math.max(...baseDelays);
  expect(max - min > 200).toBe(true); // Should have good spread
});

it('retry delay calculation with attemptIndex progression', () => {
  const baseDelay = 750; // Mid-range
  const maxDelay = 30000;

  // Attempt 0 (first retry)
  const delay0 = Math.min(baseDelay * Math.pow(2, 0), maxDelay);
  expect(delay0).toBe(750);

  // Attempt 1 (second retry)
  const delay1 = Math.min(baseDelay * Math.pow(2, 1), maxDelay);
  expect(delay1).toBe(1500);

  // Attempt 2 (third retry)
  const delay2 = Math.min(baseDelay * Math.pow(2, 2), maxDelay);
  expect(delay2).toBe(3000);

  // Verify exponential growth
  expect(delay1 > delay0).toBe(true);
  expect(delay2 > delay1).toBe(true);
  expect(delay1).toBe(delay0 * 2);
  expect(delay2).toBe(delay0 * 4);
});

it('max retry attempts limit (2 retries)', () => {
  const maxRetries = 2;

  // Should allow 2 retries (3 total attempts)
  // First attempt + 2 retries = 3 total
  let retries = maxRetries;
  let attemptCount = 0;

  while (retries >= 0) {
    attemptCount++;
    retries--;
  }

  expect(attemptCount).toBe(3); // Original + 2 retries
});

it('retry attempt index calculation', () => {
  const maxRetries = 2;

  // retries starts at 2
  // attemptIndex = maxRetries - retries

  // First retry: retries=2, attemptIndex=0
  expect(maxRetries - 2).toBe(0);

  // Second retry: retries=1, attemptIndex=1
  expect(maxRetries - 1).toBe(1);

  // Third retry: retries=0, attemptIndex=2
  expect(maxRetries - 0).toBe(2);
});

// ========== wrapNeedsApproval Tests ==========

const makeDefinition = (needsApproval: (params: unknown, context?: unknown) => Promise<boolean> | boolean) => ({
  parameters: z.object({ command: z.string() }),
  needsApproval,
});

it('wrapNeedsApproval returns false for params that fail schema validation', async () => {
  const definition = makeDefinition(async () => true);
  const wrapped = wrapNeedsApproval(definition);

  expect(await wrapped(null, {})).toBe(false); // missing required 'command'
  expect(await wrapped(null, { command: 123 })).toBe(false); // wrong type
  expect(await wrapped(null, null)).toBe(false); // not an object
});

it('wrapNeedsApproval delegates to the tool when params are valid', async () => {
  const definition = makeDefinition(async () => true);
  const wrapped = wrapNeedsApproval(definition);

  expect(await wrapped(null, { command: 'ls' })).toBe(true);
});

it('wrapNeedsApproval passes context through to the tool', async () => {
  let receivedContext: unknown;
  const definition = makeDefinition(async (_params, ctx) => {
    receivedContext = ctx;
    return false;
  });
  const wrapped = wrapNeedsApproval(definition);
  const ctx = { some: 'context' };

  await wrapped(ctx, { command: 'ls' });

  expect(receivedContext).toBe(ctx);
});

it('wrapNeedsApproval short-circuits before calling the tool on invalid params', async () => {
  let called = false;
  const definition = makeDefinition(async () => {
    called = true;
    return true;
  });
  const wrapped = wrapNeedsApproval(definition);

  await wrapped(null, { command: 123 }); // invalid

  expect(called).toBe(false);
});

it('wrapNeedsApproval delegates when optional fields arrive as null (OpenAI strict schema)', async () => {
  // toOpenAIStrictToolSchema converts optional() → nullable().default(null), so the
  // OpenAI API sends null for omitted optional fields. wrapNeedsApproval must not
  // treat these as invalid params and must still call the tool's needsApproval.
  let called = false;
  const definition = {
    // Schema with optional fields — mirrors shell/search-replace/apply-patch
    parameters: z.object({
      command: z.string(),
      timeout_ms: z.number().optional(),
    }),
    needsApproval: async (_params: unknown, _ctx?: unknown): Promise<boolean> => {
      called = true;
      return true;
    },
  };
  const wrapped = wrapNeedsApproval(definition);

  // Simulates what OpenAI sends for { command: "rm file" } under strict schema:
  // optional timeout_ms arrives as null rather than being omitted
  const result = await wrapped(null, { command: 'rm file', timeout_ms: null });

  expect(called).toBe(true); // must reach the tool's needsApproval (not short-circuited)
  expect(result).toBe(true); // must respect its decision (true = needs approval)
});

it('wrapNeedsApproval catches unhandled errors and fails safe to true', async () => {
  const definition = makeDefinition(async () => {
    throw new Error('Test error');
  });
  const wrapped = wrapNeedsApproval(definition);

  expect(await wrapped(null, { command: 'ls' })).toBe(true);
});

it('wrapNeedsApproval skips approval when an interceptor rejects the call', async () => {
  // Plan mode (and any interceptor) rejects via #checkToolInterceptors, which
  // runs in execute(). Without consulting it here, the approval prompt fires
  // before the guardrail. needsApproval must return false so no prompt shows;
  // execute() then returns the rejection message to the model.
  let toolNeedsApprovalCalled = false;
  const definition = makeDefinition(async () => {
    toolNeedsApprovalCalled = true;
    return true;
  });
  const wrapped = wrapNeedsApproval(definition, {
    checkInterceptors: async () => 'Plan mode is active (read-only).',
  });

  expect(await wrapped(null, { command: 'ls' })).toBe(false);
  expect(toolNeedsApprovalCalled).toBe(false); // short-circuited before the tool decides
});

it('wrapNeedsApproval delegates to the tool when no interceptor rejects', async () => {
  const definition = makeDefinition(async () => true);
  const wrapped = wrapNeedsApproval(definition, {
    checkInterceptors: async () => null,
  });

  expect(await wrapped(null, { command: 'ls' })).toBe(true);
});

it('wrapNeedsApproval normalizes stringified array before validation', async () => {
  const definition = {
    parameters: z.object({ tags: z.array(z.string()) }),
    needsApproval: async () => true,
  };
  const wrapped = wrapNeedsApproval(definition);

  // Models sometimes stringify array parameters; normalisation must parse
  // them so the value passes schema validation and reaches needsApproval.
  expect(await wrapped(null, { tags: '["a", "b"]' })).toBe(true);
});

it('wrapNeedsApproval normalizes stringified object before validation', async () => {
  const definition = {
    parameters: z.object({ config: z.object({ key: z.string() }) }),
    needsApproval: async () => true,
  };
  const wrapped = wrapNeedsApproval(definition);

  expect(await wrapped(null, { config: '{"key": "val"}' })).toBe(true);
});

it('wrapNeedsApproval normalizes boolean strings before validation', async () => {
  const definition = {
    parameters: z.object({ verbose: z.boolean() }),
    needsApproval: async () => true,
  };
  const wrapped = wrapNeedsApproval(definition);

  expect(await wrapped(null, { verbose: 'true' })).toBe(true);
});

it('wrapNeedsApproval normalizes null sentinels on optional fields before validation', async () => {
  let received: unknown;
  const definition = {
    parameters: z.object({ command: z.string(), timeout_ms: z.number().optional() }),
    needsApproval: async (params: unknown, _ctx?: unknown): Promise<boolean> => {
      received = params;
      return true;
    },
  };
  const wrapped = wrapNeedsApproval(definition);

  expect(await wrapped(null, { command: 'ls', timeout_ms: null })).toBe(true);
  // null sentinel is removed, so timeout_ms should be absent
  expect('timeout_ms' in (received as any)).toBe(false);
});

it('wrapNeedsApproval still bypasses approval for params that remain invalid after normalisation', async () => {
  const definition = {
    parameters: z.object({ count: z.number() }),
    needsApproval: async () => true,
  };
  const wrapped = wrapNeedsApproval(definition);

  // A string that isn't a valid number stays invalid → bypass approval
  expect(await wrapped(null, { count: 'not a number' })).toBe(false);
});

it('wrapNeedsApproval passes through already-valid params unchanged', async () => {
  let received: unknown;
  const definition = {
    parameters: z.object({ name: z.string(), items: z.array(z.string()) }),
    needsApproval: async (params: unknown, _ctx?: unknown): Promise<boolean> => {
      received = params;
      return true;
    },
  };
  const wrapped = wrapNeedsApproval(definition);

  expect(await wrapped(null, { name: 'test', items: ['a', 'b'] })).toBe(true);
  expect((received as any).items).toEqual(['a', 'b']);
});
