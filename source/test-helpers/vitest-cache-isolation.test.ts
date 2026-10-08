import os from 'node:os';
import path from 'node:path';
import envPaths from 'env-paths';
import { afterEach, expect, it, vi } from 'vitest';
import { getModelCacheDir } from '../services/model-service.js';

it('redirects the product cache dir away from the real user cache', () => {
  const realCache = envPaths('term2').cache;
  expect(process.env.TERM2_CACHE_DIR, 'setup must redirect TERM2_CACHE_DIR').toBeTruthy();
  expect(getModelCacheDir()).not.toBe(path.join(realCache, 'models'));
  expect(path.relative(os.tmpdir(), getModelCacheDir()).startsWith('..')).toBe(false);
});

// Workers can be reused across test files (vitest.shared.config.ts), and the setup
// file then runs once per file in the same process. Each file must still get its own
// cache dir, or on-disk state (conversation index, model caches) leaks between files.
const originalCacheDir = process.env.TERM2_CACHE_DIR;
afterEach(() => {
  if (originalCacheDir === undefined) delete process.env.TERM2_CACHE_DIR;
  else process.env.TERM2_CACHE_DIR = originalCacheDir;
});

it('hands each test file a fresh cache dir when the setup runs again in a reused worker', async () => {
  const first = process.env.TERM2_CACHE_DIR;
  vi.resetModules();
  await import('./vitest-cache-isolation.js');
  const second = process.env.TERM2_CACHE_DIR;

  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  expect(path.relative(os.tmpdir(), second!).startsWith('..')).toBe(false);
});

it('leaves an explicitly provided cache dir alone', async () => {
  process.env.TERM2_CACHE_DIR = path.join(os.tmpdir(), 'term2-explicit-cache-dir');
  vi.resetModules();
  await import('./vitest-cache-isolation.js');

  expect(process.env.TERM2_CACHE_DIR).toBe(path.join(os.tmpdir(), 'term2-explicit-cache-dir'));
});
