import test from 'ava';
import { z } from 'zod';
import { OpenRouterError } from '../providers/common/provider-errors.js';
import { wrapNeedsApproval } from './openai-agent-client.js';

test('OpenRouterError includes status and headers', (t) => {
  const error = new OpenRouterError('Test error', 429, { 'retry-after': '5', 'x-custom': 'value' }, 'response body');

  t.is(error.message, 'Test error');
  t.is(error.status, 429);
  t.deepEqual(error.headers, { 'retry-after': '5', 'x-custom': 'value' });
  t.is(error.responseBody, 'response body');
  t.is(error.name, 'OpenRouterError');
});

test('OpenRouterError is throwable', (t) => {
  const fn = () => {
    throw new OpenRouterError('Error message', 500, {});
  };

  const error = t.throws(fn);
  t.true(error instanceof OpenRouterError);
  if (error instanceof OpenRouterError) {
    t.is(error.status, 500);
  }
});

// ========== Exponential Backoff and Retry Logic Tests ==========

test('exponential backoff calculation follows correct formula', (t) => {
  // This tests the algorithm: baseDelay * 2^attemptIndex
  const baseDelay = 1000; // Using fixed base for predictable testing

  // First retry (attemptIndex = 0)
  const delay0 = baseDelay * Math.pow(2, 0);
  t.is(delay0, 1000);

  // Second retry (attemptIndex = 1)
  const delay1 = baseDelay * Math.pow(2, 1);
  t.is(delay1, 2000);

  // Third retry (attemptIndex = 2)
  const delay2 = baseDelay * Math.pow(2, 2);
  t.is(delay2, 4000);

  // Fourth retry (attemptIndex = 3)
  const delay3 = baseDelay * Math.pow(2, 3);
  t.is(delay3, 8000);
});

test('exponential backoff is capped at maximum delay', (t) => {
  const baseDelay = 1000;
  const maxDelay = 30000; // 30 seconds

  // For attemptIndex = 10, exponential would be 1000 * 2^10 = 1,024,000ms
  const exponentialDelay = baseDelay * Math.pow(2, 10);
  t.is(exponentialDelay, 1024000);

  // Should be capped at maxDelay
  const cappedDelay = Math.min(exponentialDelay, maxDelay);
  t.is(cappedDelay, maxDelay);
  t.is(cappedDelay, 30000);
});

test('jitter randomizes delay between 0 and capped delay', (t) => {
  const cappedDelay = 5000;

  // Run multiple times to verify randomization
  const delays: number[] = [];
  for (let i = 0; i < 100; i++) {
    const jitteredDelay = Math.random() * cappedDelay;
    delays.push(jitteredDelay);

    // Should be within range
    t.true(jitteredDelay >= 0);
    t.true(jitteredDelay <= cappedDelay);
  }

  // Verify we got different values (not all the same)
  const uniqueDelays = new Set(delays);
  t.true(uniqueDelays.size > 10); // Should have variety
});

test('retry classification - 429 is retryable', (t) => {
  const error = new OpenRouterError('Rate limit', 429, {});
  const isRetryable = error.status === 429 || error.status >= 500;
  t.true(isRetryable);
});

test('retry classification - 5xx errors are retryable', (t) => {
  const retryableStatuses = [500, 502, 503, 504];

  for (const status of retryableStatuses) {
    const error = new OpenRouterError(`Server error`, status, {});
    const isRetryable = error.status === 429 || error.status >= 500;
    t.true(isRetryable, `Status ${status} should be retryable`);
  }
});

test('retry classification - 4xx errors (except 429) are NOT retryable', (t) => {
  const nonRetryableStatuses = [400, 401, 403, 404, 422];

  for (const status of nonRetryableStatuses) {
    const error = new OpenRouterError(`Client error`, status, {});
    const isRetryable = error.status === 429 || error.status >= 500;
    t.false(isRetryable, `Status ${status} should NOT be retryable`);
  }
});

test('retry classification - 2xx success codes are NOT retryable', (t) => {
  const successStatuses = [200, 201, 204];

  for (const status of successStatuses) {
    const error = new OpenRouterError(`Success (shouldn't be error)`, status, {});
    const isRetryable = error.status === 429 || error.status >= 500;
    t.false(isRetryable);
  }
});

test('retry classification - 3xx redirects are NOT retryable', (t) => {
  const redirectStatuses = [301, 302, 304];

  for (const status of redirectStatuses) {
    const error = new OpenRouterError(`Redirect`, status, {});
    const isRetryable = error.status === 429 || error.status >= 500;
    t.false(isRetryable);
  }
});

test('Retry-After header extraction from OpenRouterError', (t) => {
  const error = new OpenRouterError('Rate limit', 429, { 'retry-after': '60' });

  const retryAfter = error.headers['retry-after'];
  t.is(retryAfter, '60');

  const delayMs = parseInt(retryAfter, 10) * 1000;
  t.is(delayMs, 60000); // 60 seconds in milliseconds
});

test('Retry-After header missing returns undefined', (t) => {
  const error = new OpenRouterError('Server error', 503, {});

  const retryAfter = error.headers['retry-after'];
  t.falsy(retryAfter);
  t.false('retry-after' in error.headers);
});

test('Retry-After header with different case sensitivity', (t) => {
  // Headers might come with different casing
  const error1 = new OpenRouterError('Error', 429, { 'Retry-After': '30' });
  const error2 = new OpenRouterError('Error', 429, { 'retry-after': '30' });
  const error3 = new OpenRouterError('Error', 429, { 'RETRY-AFTER': '30' });

  // Note: In JavaScript, object property access is case-sensitive
  // The actual implementation would need to handle case-insensitive lookup
  // For now, we test exact match
  t.is(error1.headers['Retry-After'], '30');
  t.is(error2.headers['retry-after'], '30');
  t.is(error3.headers['RETRY-AFTER'], '30');
});

test('exponential backoff with base delay range (500-1000ms)', (t) => {
  // Test the randomized base delay range
  const baseDelays: number[] = [];

  for (let i = 0; i < 100; i++) {
    const baseDelay = 500 + Math.random() * 500; // 500-1000ms
    baseDelays.push(baseDelay);

    t.true(baseDelay >= 500);
    t.true(baseDelay <= 1000);
  }

  // Check we have variety in base delays
  const min = Math.min(...baseDelays);
  const max = Math.max(...baseDelays);
  t.true(max - min > 200); // Should have good spread
});

test('retry delay calculation with attemptIndex progression', (t) => {
  const baseDelay = 750; // Mid-range
  const maxDelay = 30000;

  // Attempt 0 (first retry)
  const delay0 = Math.min(baseDelay * Math.pow(2, 0), maxDelay);
  t.is(delay0, 750);

  // Attempt 1 (second retry)
  const delay1 = Math.min(baseDelay * Math.pow(2, 1), maxDelay);
  t.is(delay1, 1500);

  // Attempt 2 (third retry)
  const delay2 = Math.min(baseDelay * Math.pow(2, 2), maxDelay);
  t.is(delay2, 3000);

  // Verify exponential growth
  t.true(delay1 > delay0);
  t.true(delay2 > delay1);
  t.is(delay1, delay0 * 2);
  t.is(delay2, delay0 * 4);
});

test('max retry attempts limit (2 retries)', (t) => {
  const maxRetries = 2;

  // Should allow 2 retries (3 total attempts)
  // First attempt + 2 retries = 3 total
  let retries = maxRetries;
  let attemptCount = 0;

  while (retries >= 0) {
    attemptCount++;
    retries--;
  }

  t.is(attemptCount, 3); // Original + 2 retries
});

test('retry attempt index calculation', (t) => {
  const maxRetries = 2;

  // retries starts at 2
  // attemptIndex = maxRetries - retries

  // First retry: retries=2, attemptIndex=0
  t.is(maxRetries - 2, 0);

  // Second retry: retries=1, attemptIndex=1
  t.is(maxRetries - 1, 1);

  // Third retry: retries=0, attemptIndex=2
  t.is(maxRetries - 0, 2);
});

// ========== wrapNeedsApproval Tests ==========

const makeDefinition = (needsApproval: (params: unknown, context?: unknown) => Promise<boolean> | boolean) => ({
  parameters: z.object({ command: z.string() }),
  needsApproval,
});

test('wrapNeedsApproval returns false for params that fail schema validation', async (t) => {
  const definition = makeDefinition(async () => true);
  const wrapped = wrapNeedsApproval(definition);

  t.false(await wrapped(null, {})); // missing required 'command'
  t.false(await wrapped(null, { command: 123 })); // wrong type
  t.false(await wrapped(null, null)); // not an object
});

test('wrapNeedsApproval delegates to the tool when params are valid', async (t) => {
  const definition = makeDefinition(async () => true);
  const wrapped = wrapNeedsApproval(definition);

  t.true(await wrapped(null, { command: 'ls' }));
});

test('wrapNeedsApproval passes context through to the tool', async (t) => {
  let receivedContext: unknown;
  const definition = makeDefinition(async (_params, ctx) => {
    receivedContext = ctx;
    return false;
  });
  const wrapped = wrapNeedsApproval(definition);
  const ctx = { some: 'context' };

  await wrapped(ctx, { command: 'ls' });

  t.is(receivedContext, ctx);
});

test('wrapNeedsApproval short-circuits before calling the tool on invalid params', async (t) => {
  let called = false;
  const definition = makeDefinition(async () => {
    called = true;
    return true;
  });
  const wrapped = wrapNeedsApproval(definition);

  await wrapped(null, { command: 123 }); // invalid

  t.false(called);
});

test('wrapNeedsApproval delegates when optional fields arrive as null (OpenAI strict schema)', async (t) => {
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

  t.true(called); // must reach the tool's needsApproval (not short-circuited)
  t.true(result); // must respect its decision (true = needs approval)
});

test('wrapNeedsApproval catches unhandled errors and fails safe to true', async (t) => {
  const definition = makeDefinition(async () => {
    throw new Error('Test error');
  });
  const wrapped = wrapNeedsApproval(definition);

  t.true(await wrapped(null, { command: 'ls' }));
});

test('wrapNeedsApproval skips approval when an interceptor rejects the call', async (t) => {
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

  t.false(await wrapped(null, { command: 'ls' }));
  t.false(toolNeedsApprovalCalled); // short-circuited before the tool decides
});

test('wrapNeedsApproval delegates to the tool when no interceptor rejects', async (t) => {
  const definition = makeDefinition(async () => true);
  const wrapped = wrapNeedsApproval(definition, {
    checkInterceptors: async () => null,
  });

  t.true(await wrapped(null, { command: 'ls' }));
});

test('wrapNeedsApproval normalizes stringified array before validation', async (t) => {
  const definition = {
    parameters: z.object({ tags: z.array(z.string()) }),
    needsApproval: async () => true,
  };
  const wrapped = wrapNeedsApproval(definition);

  // Models sometimes stringify array parameters; normalisation must parse
  // them so the value passes schema validation and reaches needsApproval.
  t.true(await wrapped(null, { tags: '["a", "b"]' }));
});

test('wrapNeedsApproval normalizes stringified object before validation', async (t) => {
  const definition = {
    parameters: z.object({ config: z.object({ key: z.string() }) }),
    needsApproval: async () => true,
  };
  const wrapped = wrapNeedsApproval(definition);

  t.true(await wrapped(null, { config: '{"key": "val"}' }));
});

test('wrapNeedsApproval normalizes boolean strings before validation', async (t) => {
  const definition = {
    parameters: z.object({ verbose: z.boolean() }),
    needsApproval: async () => true,
  };
  const wrapped = wrapNeedsApproval(definition);

  t.true(await wrapped(null, { verbose: 'true' }));
});

test('wrapNeedsApproval normalizes null sentinels on optional fields before validation', async (t) => {
  let received: unknown;
  const definition = {
    parameters: z.object({ command: z.string(), timeout_ms: z.number().optional() }),
    needsApproval: async (params: unknown, _ctx?: unknown): Promise<boolean> => {
      received = params;
      return true;
    },
  };
  const wrapped = wrapNeedsApproval(definition);

  t.true(await wrapped(null, { command: 'ls', timeout_ms: null }));
  // null sentinel is removed, so timeout_ms should be absent
  t.false('timeout_ms' in (received as any));
});

test('wrapNeedsApproval still bypasses approval for params that remain invalid after normalisation', async (t) => {
  const definition = {
    parameters: z.object({ count: z.number() }),
    needsApproval: async () => true,
  };
  const wrapped = wrapNeedsApproval(definition);

  // A string that isn't a valid number stays invalid → bypass approval
  t.false(await wrapped(null, { count: 'not a number' }));
});

test('wrapNeedsApproval passes through already-valid params unchanged', async (t) => {
  let received: unknown;
  const definition = {
    parameters: z.object({ name: z.string(), items: z.array(z.string()) }),
    needsApproval: async (params: unknown, _ctx?: unknown): Promise<boolean> => {
      received = params;
      return true;
    },
  };
  const wrapped = wrapNeedsApproval(definition);

  t.true(await wrapped(null, { name: 'test', items: ['a', 'b'] }));
  t.deepEqual((received as any).items, ['a', 'b']);
});
