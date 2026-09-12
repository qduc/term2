// Guards the property the file-tool boundary fixtures depend on: the root
// returned here is writable and is not inside any allow-listed temp dir. A
// revert to plain `os.tmpdir()` re-breaks the boundary tests whenever the suite
// runs with TMPDIR set to SANDBOX_TEMP_DIR (e.g. from a term2 sandboxed shell).
import { it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveOutsideSandboxTempRoot } from './outside-sandbox-temp-dir.js';
import { SANDBOX_TEMP_DIR } from '../utils/shell/temp-dir.js';

it('resolveOutsideSandboxTempRoot: returns a writable directory outside SANDBOX_TEMP_DIR', async () => {
  const root = resolveOutsideSandboxTempRoot();
  expect(root === SANDBOX_TEMP_DIR || root.startsWith(SANDBOX_TEMP_DIR + path.sep)).toBe(false);
  expect(path.isAbsolute(root)).toBe(true);

  const dir = await mkdtemp(path.join(root, 'term2-outside-sandbox-temp-'));
  try {
    expect(dir.startsWith(SANDBOX_TEMP_DIR + path.sep)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('resolveOutsideSandboxTempRoot: keeps os.tmpdir() when it already qualifies, else falls back to an existing ancestor', () => {
  const systemTempDir = path.resolve(tmpdir());
  const systemTempDirQualifies =
    systemTempDir !== SANDBOX_TEMP_DIR && !systemTempDir.startsWith(SANDBOX_TEMP_DIR + path.sep);

  const root = resolveOutsideSandboxTempRoot();

  expect(root).toBe(systemTempDirQualifies ? systemTempDir : path.dirname(SANDBOX_TEMP_DIR));
  expect(existsSync(root)).toBe(true);
});
