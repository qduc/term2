import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

export default function setup(project: TestProject) {
  // An explicitly supplied cache belongs to the caller, not the test runner.
  if (process.env.TERM2_CACHE_DIR) return;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-test-cache-'));
  project.provide('term2TestCacheRoot', root);
  return () => fs.rmSync(root, { recursive: true, force: true });
}
