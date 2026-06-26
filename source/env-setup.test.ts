import { afterEach, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

it('env-setup disables openai agents tracing globally', async () => {
  await import('./env-setup.js');

  expect(process.env.OPENAI_AGENTS_DISABLE_TRACING).toBe('true');
});

it('env-setup defaults NODE_ENV to production before React and Ink load', async () => {
  delete process.env.NODE_ENV;

  await import('./env-setup.js');

  expect(process.env.NODE_ENV).toBe('production');
});

it('env-setup preserves explicit NODE_ENV values', async () => {
  process.env.NODE_ENV = 'test';

  await import('./env-setup.js');

  expect(process.env.NODE_ENV).toBe('test');
});
