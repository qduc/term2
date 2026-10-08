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
//
// This file runs once per test file. In an isolated run that is once per process;
// in a reused worker (vitest.shared.config.ts) it runs again in the same process,
// and a directory this file created for the previous file must not carry over, or
// on-disk state such as the conversation index leaks between files. So the
// directory this file created is replaced; one supplied from outside is not.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OWNED_DIR = Symbol.for('term2.test.ownedCacheDir');
const owned = (globalThis as Record<symbol, string | undefined>)[OWNED_DIR];

if (!process.env.TERM2_CACHE_DIR || process.env.TERM2_CACHE_DIR === owned) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-test-cache-'));
  process.env.TERM2_CACHE_DIR = dir;
  (globalThis as Record<symbol, string | undefined>)[OWNED_DIR] = dir;
}
