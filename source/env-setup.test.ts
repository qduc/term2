import { afterEach, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

// Restore in place: assigning `process.env = copy` replaces Node's environment object with a
// plain object, which stops later assignments reaching the real environment (worker threads
// read that one) for everything that shares this process afterwards.
function restoreEnv(saved: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
}

afterEach(() => {
  restoreEnv(originalEnv);
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
