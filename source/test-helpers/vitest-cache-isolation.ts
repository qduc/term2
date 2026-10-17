// Suite-wide test sandbox: never let tests read or write the developer's real
// product cache (~/.cache/term2-nodejs).
//
// Several tests drive the real model-service fetchModels/clearModelCache path
// with stub providers — notably fake single-model `codex` stubs. Without
// isolation those stubs were persisted to the real models/codex.json, and the
// next real session served a one-model catalog until a manual refresh cleared
// it. Per-test overrides (TERM2_CACHE_DIR, setModelCacheDirForTest, explicit
// cacheDir args) still win; this only changes the default. An explicitly set
// TERM2_CACHE_DIR is left alone.
import fs from 'node:fs';
import path from 'node:path';
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    term2TestCacheRoot: string;
  }
}

if (!process.env.TERM2_CACHE_DIR) {
  // The runner owns this root and disposes it after workers finish, including
  // collection errors that skip suite hooks. Keep each file's cache isolated.
  const root = inject('term2TestCacheRoot');
  if (!root) throw new Error('Vitest cache isolation requires vitest-cache-global-setup.ts');
  process.env.TERM2_CACHE_DIR = fs.mkdtempSync(path.join(root, 'suite-'));
}
