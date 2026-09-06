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
import os from 'node:os';
import path from 'node:path';

if (!process.env.TERM2_CACHE_DIR) {
  process.env.TERM2_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-test-cache-'));
}
