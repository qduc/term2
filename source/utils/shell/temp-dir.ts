import { mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

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

export interface SandboxXdgLayout {
  root: string;
  config: string;
  cache: string;
  data: string;
  state: string;
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function resolveWorkspaceRoot(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolvePath(cwd);
  }
}

export function resolveSandboxXdgLayout(cwd: string): SandboxXdgLayout {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const workspaceHash = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
  const xdgRoot = join(SANDBOX_TEMP_DIR, 'xdg');
  const root = join(xdgRoot, workspaceHash);
  const config = join(root, 'config');
  const cache = join(root, 'cache');
  const data = join(root, 'data');
  const state = join(root, 'state');

  ensurePrivateDir(xdgRoot);
  ensurePrivateDir(root);
  ensurePrivateDir(config);
  ensurePrivateDir(cache);
  ensurePrivateDir(data);
  ensurePrivateDir(state);

  return { root, config, cache, data, state };
}
