import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

/**
 * Per-user, deterministic temp directory for sandboxed shell commands.
 *
 * Resolves to a deterministic per-user location matching env-paths:
 *  - macOS:   `${os.tmpdir()}/term2-nodejs`       (tmpdir is user-private)
 *  - Linux:   `${os.tmpdir()}/${username}/term2-nodejs`
 *  - Windows: `${os.tmpdir()}/term2-nodejs`
 *
 * If TMPDIR already contains the app directory suffix — e.g. because a
 * prior session or container set TMPDIR=/tmp/qduc/term2-nodejs — uses
 * `os.tmpdir()` directly to avoid duplication.
 *
 * On macOS `os.tmpdir()` may return a symlinked path; we resolve it so the
 * sandbox allowWrite entry matches the path a child process writes through.
 */
const appDir = 'term2-nodejs';

function resolveTempDir(): string {
  const base = tmpdir();

  // Avoid double-pathing: if the system tmpdir already ends with our app
  // directory suffix, use it as-is.
  if (base.endsWith(appDir)) {
    return base;
  }

  if (process.platform === 'darwin') {
    // macOS: os.tmpdir() is already user-private.
    return join(base, appDir);
  }

  // Linux/others: add per-user isolation.
  return join(base, basename(homedir()), appDir);
}

const tempPath = resolveTempDir();
mkdirSync(tempPath, { recursive: true });

export const SANDBOX_TEMP_DIR = realpathSync(tempPath);
