import test from 'ava';
import {
  createCacheKey,
  EVAL_CACHE_VERSION,
  getReportPath,
  retryOnRateLimit,
  validateRunnerOptions,
} from './runner-utils.js';

test('getReportPath produces a distinct markdown path for json and extensionless outputs', (t) => {
  t.is(getReportPath('eval/auto-approval/results.json'), 'eval/auto-approval/results.md');
  t.is(getReportPath('eval/auto-approval/results'), 'eval/auto-approval/results.md');
});

test('validateRunnerOptions rejects non-positive concurrency and repeat values', (t) => {
  t.notThrows(() => validateRunnerOptions({ concurrency: 1, repeat: 1 }));
  t.throws(() => validateRunnerOptions({ concurrency: 0, repeat: 1 }), {
    message: /--concurrency/,
  });
  t.throws(() => validateRunnerOptions({ concurrency: 1, repeat: 0 }), {
    message: /--repeat/,
  });
});

test('createCacheKey includes evaluator version to invalidate stale cached decisions', (t) => {
  const key = createCacheKey({
    model: 'gpt-4o-mini',
    provider: 'openai',
    promptVersion: 'auto-approval-prompt-v1',
    command: 'ls',
    history: [{ role: 'user', content: 'list files' }],
  });

  t.is(key.version, EVAL_CACHE_VERSION);
  t.is(key.promptVersion, 'auto-approval-prompt-v1');
});

test('createCacheKey changes when prompt version changes', (t) => {
  const base = {
    model: 'gpt-4o-mini',
    provider: 'openai',
    command: 'ls',
    history: [{ role: 'user', content: 'list files' }],
  };

  t.notDeepEqual(
    createCacheKey({ ...base, promptVersion: 'auto-approval-prompt-v1' }),
    createCacheKey({ ...base, promptVersion: 'auto-approval-prompt-v2' }),
  );
});

test('retryOnRateLimit retries twice and respects x-ratelimit-reset before succeeding', async (t) => {
  let attempts = 0;
  const sleepCalls: number[] = [];
  const now = 1_741_305_599_000;

  const result = await retryOnRateLimit({
    operation: async () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error('Rate limit exceeded');
        (err as Error & { status: number; headers: Record<string, string> }).status = 429;
        (err as Error & { status: number; headers: Record<string, string> }).headers = {
          'X-RateLimit-Reset': String(now + 1_500),
        };
        throw err;
      }

      return 'ok';
    },
    maxRetries: 2,
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    now: () => now,
  });

  t.is(result, 'ok');
  t.is(attempts, 3);
  t.deepEqual(sleepCalls, [1500, 1500]);
});

test('retryOnRateLimit rethrows after exhausting retries', async (t) => {
  let attempts = 0;
  const sleepCalls: number[] = [];

  const error = await t.throwsAsync(() =>
    retryOnRateLimit({
      operation: async () => {
        attempts++;
        const err = Object.assign(new Error('Too Many Requests'), {
          error: {
            code: 429,
            metadata: {
              headers: {
                'X-RateLimit-Reset': '1741305600000',
              },
            },
          },
        });
        throw err;
      },
      maxRetries: 2,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      now: () => 1_741_305_599_000,
    }),
  );

  t.truthy(error);
  t.is(attempts, 3);
  t.deepEqual(sleepCalls, [1000, 1000]);
});

test('retryOnRateLimit does not retry non-rate-limit errors', async (t) => {
  let attempts = 0;

  const error = await t.throwsAsync(() =>
    retryOnRateLimit({
      operation: async () => {
        attempts++;
        const err = new Error('boom');
        (err as Error & { status: number }).status = 500;
        throw err;
      },
      maxRetries: 2,
      sleep: async () => {},
    }),
  );

  t.truthy(error);
  t.is(attempts, 1);
});
