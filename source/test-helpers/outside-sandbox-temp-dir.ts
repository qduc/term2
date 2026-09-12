// A temp-directory root that file-tool fixtures can use as a location the tools
// treat as outside every allow-listed root.
//
// The file tools auto-approve writes inside SANDBOX_TEMP_DIR, so a boundary
// fixture must not create its "outside" directory under a path the tools allow.
// `os.tmpdir()` normally works, because SANDBOX_TEMP_DIR is a subdirectory of it
// and a `mkdtemp` under os.tmpdir() therefore sits outside the sandbox temp dir.
// But term2 sets TMPDIR to SANDBOX_TEMP_DIR for sandboxed shell children, so a
// test run launched from a term2 sandboxed shell inherits `TMPDIR ===
// SANDBOX_TEMP_DIR`, and every `mkdtemp` under os.tmpdir() lands *inside* the
// allow-listed sandbox temp dir — silently masking the workspace-boundary checks
// those tests exist to exercise.
//
// When that happens, fall back to the nearest existing ancestor of
// SANDBOX_TEMP_DIR. Ancestors are outside SANDBOX_TEMP_DIR by construction, and
// one of them exists whenever TMPDIR pointed at the sandbox temp dir.
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SANDBOX_TEMP_DIR } from '../utils/shell/temp-dir.js';

export function resolveOutsideSandboxTempRoot(): string {
  const systemTempDir = path.resolve(tmpdir());
  if (!isInsideOrEqual(systemTempDir, SANDBOX_TEMP_DIR)) return systemTempDir;

  let candidate = path.dirname(SANDBOX_TEMP_DIR);
  while (!existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

function isInsideOrEqual(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  return candidate === resolvedRoot || candidate.startsWith(resolvedRoot + path.sep);
}
