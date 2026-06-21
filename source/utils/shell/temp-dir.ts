import { mkdirSync, realpathSync } from 'node:fs';
import envPaths from 'env-paths';

/**
 * Per-user, deterministic temp directory for sandboxed shell commands.
 *
 * Uses `envPaths('term2').temp`, which resolves to a per-user location:
 *  - macOS: `/var/folders/<hash>/T/term2-nodejs` (OS-managed, user-only)
 *  - Linux: `/tmp/<username>/term2-nodejs` (conventional per-user tmp)
 *
 * On macOS `os.tmpdir()` may return a symlinked path; we resolve it so the
 * sandbox allowWrite entry matches the path a child process writes through.
 */
const tempPath = envPaths('term2').temp;
mkdirSync(tempPath, { recursive: true });

export const SANDBOX_TEMP_DIR = realpathSync(tempPath);
