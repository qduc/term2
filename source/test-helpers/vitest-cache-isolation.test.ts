import os from 'node:os';
import path from 'node:path';
import envPaths from 'env-paths';
import { expect, it } from 'vitest';
import { getModelCacheDir } from '../services/model-service.js';

it('redirects the product cache dir away from the real user cache', () => {
  const realCache = envPaths('term2').cache;
  expect(process.env.TERM2_CACHE_DIR, 'setup must redirect TERM2_CACHE_DIR').toBeTruthy();
  expect(getModelCacheDir()).not.toBe(path.join(realCache, 'models'));
  expect(path.relative(os.tmpdir(), getModelCacheDir()).startsWith('..')).toBe(false);
});
