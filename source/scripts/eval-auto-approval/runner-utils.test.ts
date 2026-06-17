import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCacheKey,
  EVAL_CACHE_VERSION,
  getReportPath,
  loadModelRunsFromYaml,
  retryOnRateLimit,
  validateRunnerOptions,
} from './runner-utils.js';

it('getReportPath produces a distinct markdown path for json and extensionless outputs', () => {
  expect(getReportPath('eval/auto-approval/results.json')).toBe('eval/auto-approval/results.md');
  expect(getReportPath('eval/auto-approval/results')).toBe('eval/auto-approval/results.md');
});

it('validateRunnerOptions rejects non-positive concurrency and repeat values', () => {
  expect(() => validateRunnerOptions({ concurrency: 1, repeat: 1 }));

  expect(() => validateRunnerOptions({ concurrency: 0, repeat: 1 })).toThrow(/--concurrency/);

  expect(() => validateRunnerOptions({ concurrency: 1, repeat: 0 })).toThrow(/--repeat/);
});

it('createCacheKey includes evaluator version to invalidate stale cached decisions', () => {
  const key = createCacheKey({
    model: 'gpt-4o-mini',
    provider: 'openai',
    promptVersion: 'auto-approval-prompt-v1',
    command: 'ls',
    history: [{ role: 'user', content: 'list files' }],
  });

  expect(key.version).toBe(EVAL_CACHE_VERSION);
  expect(key.promptVersion).toBe('auto-approval-prompt-v1');
});

it('createCacheKey changes when prompt version changes', () => {
  const base = {
    model: 'gpt-4o-mini',
    provider: 'openai',
    command: 'ls',
    history: [{ role: 'user', content: 'list files' }],
  };

  expect(createCacheKey({ ...base, promptVersion: 'auto-approval-prompt-v1' })).not.toEqual(
    createCacheKey({ ...base, promptVersion: 'auto-approval-prompt-v2' }),
  );
});

it('loadModelRunsFromYaml expands provider keys into ordered provider/model pairs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'term2-eval-'));
  const yamlPath = join(dir, 'models.yaml');

  writeFileSync(
    yamlPath,
    `
openai:
  - gpt-4o
  - gpt-4o-mini
openrouter:
  - anthropic/claude-3.5-sonnet
`,
  );

  expect(loadModelRunsFromYaml(yamlPath)).toEqual([
    { provider: 'openai', model: 'gpt-4o' },
    { provider: 'openai', model: 'gpt-4o-mini' },
    { provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet' },
  ]);
});

it('loadModelRunsFromYaml rejects providers without a model list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'term2-eval-'));
  const yamlPath = join(dir, 'models.yaml');

  writeFileSync(
    yamlPath,
    `
openai: gpt-4o
`,
  );

  expect(() => loadModelRunsFromYaml(yamlPath)).toThrow(/must map to a list of models/);
});

it('retryOnRateLimit retries twice and respects x-ratelimit-reset before succeeding', async () => {
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

  expect(result).toBe('ok');
  expect(attempts).toBe(3);
  expect(sleepCalls).toEqual([1500, 1500]);
});

it('retryOnRateLimit rethrows after exhausting retries', async () => {
  let attempts = 0;
  const sleepCalls: number[] = [];

  await expect(() =>
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
  ).rejects.toThrow();

  expect(attempts).toBe(3);
  expect(sleepCalls).toEqual([1000, 1000]);
});

it('retryOnRateLimit does not retry non-rate-limit errors', async () => {
  let attempts = 0;

  await expect(() =>
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
  ).rejects.toThrow();

  expect(attempts).toBe(1);
});
