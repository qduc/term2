import { it, expect } from 'vitest';
import { z } from 'zod';
import { OpenRouterError } from '../providers/common/provider-errors.js';
import {
  classifyUpstreamRetryableError,
  computeUpstreamRetryDelayMs,
} from '../services/retry/upstream-retry-policy.js';
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

// ========== Production retry classification and delay ==========

it('production retry policy consumes OpenRouterError status and Retry-After metadata', () => {
  // The metadata cases above are what provider retry handling actually reads:
  // classifyUpstreamRetryableError drives RetryingModel's retry decision and
  // computeUpstreamRetryDelayMs picks the backoff. These cases exercise that
  // production path rather than a locally recomputed formula.
  const rateLimited = classifyUpstreamRetryableError(new OpenRouterError('Rate limit', 429, { 'retry-after': '5' }));
  expect(rateLimited).toEqual({ retryable: true, status: 429, retryAfterMs: 5000, reason: 'provider-status' });

  for (const status of [500, 502, 503, 504]) {
    expect(classifyUpstreamRetryableError(new OpenRouterError('Server error', status, {}))).toMatchObject({
      retryable: true,
      status,
      reason: 'provider-status',
    });
  }

  for (const status of [400, 401, 403, 404, 422]) {
    expect(classifyUpstreamRetryableError(new OpenRouterError('Client error', status, {}))).toMatchObject({
      retryable: false,
      status,
      reason: 'provider-status',
    });
  }

  // Retry-After wins over the exponential backoff schedule.
  expect(computeUpstreamRetryDelayMs({ retryAfterMs: 60_000, attemptIndex: 3, random: () => 0.99 })).toBe(60_000);
});

// ========== wrapNeedsApproval Tests ==========

const makeDefinition = (needsApproval: (params: unknown, context?: unknown) => Promise<boolean> | boolean) => ({
  parameters: z.object({ command: z.string() }),
  needsApproval,
});

it('wrapNeedsApproval returns false for params that fail schema validation', async () => {
  const definition = makeDefinition(async () => true);
  const wrapped = wrapNeedsApproval(definition);

  expect(await wrapped({}, null)).toBe(false); // missing required 'command'
  expect(await wrapped({ command: 123 }, null)).toBe(false); // wrong type
  expect(await wrapped(null, null)).toBe(false); // not an object
});

it('wrapNeedsApproval delegates to the tool when params are valid', async () => {
  const definition = makeDefinition(async () => true);
  const wrapped = wrapNeedsApproval(definition);

  expect(await wrapped({ command: 'ls' }, null)).toBe(true);
});

it('wrapNeedsApproval passes context through to the tool', async () => {
  let receivedContext: unknown;
  const definition = makeDefinition(async (_params, ctx) => {
    receivedContext = ctx;
    return false;
  });
  const wrapped = wrapNeedsApproval(definition);
  const ctx = { some: 'context' };

  await wrapped({ command: 'ls' }, ctx);

  expect(receivedContext).toBe(ctx);
});

it('wrapNeedsApproval short-circuits before calling the tool on invalid params', async () => {
  let called = false;
  const definition = makeDefinition(async () => {
    called = true;
    return true;
  });
  const wrapped = wrapNeedsApproval(definition);

  await wrapped({ command: 123 }, null); // invalid

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
  const result = await wrapped({ command: 'rm file', timeout_ms: null }, null);

  expect(called).toBe(true); // must reach the tool's needsApproval (not short-circuited)
  expect(result).toBe(true); // must respect its decision (true = needs approval)
});

it('wrapNeedsApproval catches unhandled errors and fails safe to true', async () => {
  const definition = makeDefinition(async () => {
    throw new Error('Test error');
  });
  const wrapped = wrapNeedsApproval(definition);

  expect(await wrapped({ command: 'ls' }, null)).toBe(true);
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

  expect(await wrapped({ command: 'ls' }, null)).toBe(false);
  expect(toolNeedsApprovalCalled).toBe(false); // short-circuited before the tool decides
});

it('wrapNeedsApproval delegates to the tool when no interceptor rejects', async () => {
  const definition = makeDefinition(async () => true);
  const wrapped = wrapNeedsApproval(definition, {
    checkInterceptors: async () => null,
  });

  expect(await wrapped({ command: 'ls' }, null)).toBe(true);
});

it('wrapNeedsApproval normalizes stringified array before validation', async () => {
  const definition = {
    parameters: z.object({ tags: z.array(z.string()) }),
    needsApproval: async () => true,
  };
  const wrapped = wrapNeedsApproval(definition);

  // Models sometimes stringify array parameters; normalisation must parse
  // them so the value passes schema validation and reaches needsApproval.
  expect(await wrapped({ tags: '["a", "b"]' }, null)).toBe(true);
});

it('wrapNeedsApproval normalizes stringified object before validation', async () => {
  const definition = {
    parameters: z.object({ config: z.object({ key: z.string() }) }),
    needsApproval: async () => true,
  };
  const wrapped = wrapNeedsApproval(definition);

  expect(await wrapped({ config: '{"key": "val"}' }, null)).toBe(true);
});

it('wrapNeedsApproval normalizes boolean strings before validation', async () => {
  const definition = {
    parameters: z.object({ verbose: z.boolean() }),
    needsApproval: async () => true,
  };
  const wrapped = wrapNeedsApproval(definition);

  expect(await wrapped({ verbose: 'true' }, null)).toBe(true);
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

  expect(await wrapped({ command: 'ls', timeout_ms: null }, null)).toBe(true);
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
  expect(await wrapped({ count: 'not a number' }, null)).toBe(false);
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

  expect(await wrapped({ name: 'test', items: ['a', 'b'] }, null)).toBe(true);
  expect((received as any).items).toEqual(['a', 'b']);
});
