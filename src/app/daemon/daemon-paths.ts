/**
 * Daemon runtime path resolution, filesystem permission checks, exclusive SQLite
 * singleton lock, stale socket cleanup, and atomic advisory `daemon.json`.
 *
 * Implements `docs/plans/daemon/spec/transport-unix.md` §§1.1–1.2 strictly:
 * - Never places sockets or runtime files in world-writable `/tmp` by default.
 * - Verifies real directory ownership and 0o700 permissions via `lstat()`.
 * - Unlinks a stale socket ONLY while holding `daemon.lock.sqlite` and ONLY after
 *   probing `connect()` and confirming `lstat().isSocket()`.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { checkConversationsDirectory, resolveConversationsDirectory, resolvedStorePath } from './store-paths.js';

export { checkConversationsDirectory, resolveConversationsDirectory };

export type DaemonPaths = {
  readonly stateDir: string;
  readonly conversationsDir: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly lockPath: string;
  readonly advertisementPath: string;
};

export type DaemonAdvertisement = {
  readonly daemonId: string;
  readonly pid: number;
  readonly procStartTime: string | number;
  readonly startedAt: string;
  readonly socketPath: string;
  readonly daemonVersion: string;
  readonly protocolVersion: string;
};

class DaemonLockBusyError extends Error {
  constructor(lockPath: string, cause?: unknown) {
    super(`Daemon lock is already held: ${lockPath}`, { cause });
    this.name = 'DaemonLockBusyError';
  }
}

export function resolveDaemonPaths(
  options: {
    readonly stateDir?: string;
    readonly conversationsDir?: string;
    readonly socketPath?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): DaemonPaths {
  const env = options.env ?? process.env;
  const conversationsDir = options.conversationsDir
    ? resolvedStorePath(options.conversationsDir)
    : resolveConversationsDirectory(env);
  // Clients pass the store they resolved, the default one included, so "a path was given" does not mean
  // "another store": compare by value, or `term2 serve` and `term2 daemon status|stop` reach another socket.
  const conversationsOverridden = conversationsDir !== resolveConversationsDirectory({});

  let stateDir: string;
  const xdgState = env['XDG_STATE_HOME']?.trim() || path.join(os.homedir(), '.local', 'state');
  if (options.stateDir) {
    stateDir = resolvedStorePath(options.stateDir);
  } else if (conversationsOverridden) {
    // A private directory per store, never the store's parent: the daemon makes its state directory
    // 0700 and keeps its lock there, which would chmod a shared parent such as /tmp or the home
    // directory (deviation from transport-unix.md §1.1, recorded in decisions.md).
    stateDir = path.join(
      xdgState,
      'term2',
      'stores',
      createHash('sha256').update(conversationsDir).digest('hex').slice(0, 12),
    );
  } else {
    stateDir = path.join(xdgState, 'term2');
  }

  let runtimeDir: string;
  if (env['TERM2_DAEMON_DIR']?.trim()) {
    runtimeDir = resolvedStorePath(env['TERM2_DAEMON_DIR'].trim());
  } else if (env['XDG_RUNTIME_DIR']?.trim()) {
    const base = env['XDG_RUNTIME_DIR'].trim();
    const suffix = conversationsOverridden
      ? `term2-daemon-${createHash('sha256').update(stateDir).digest('hex').slice(0, 12)}`
      : 'term2-daemon';
    runtimeDir = path.join(base, suffix);
  } else {
    runtimeDir = path.join(stateDir, 'run');
  }

  const socketPath = options.socketPath
    ? resolvedStorePath(options.socketPath)
    : env['TERM2_DAEMON_SOCKET']?.trim()
    ? resolvedStorePath(env['TERM2_DAEMON_SOCKET'].trim())
    : path.join(runtimeDir, 'daemon.sock');

  return {
    stateDir,
    conversationsDir,
    runtimeDir,
    socketPath,
    lockPath: path.join(stateDir, 'daemon.lock.sqlite'),
    advertisementPath: path.join(runtimeDir, 'daemon.json'),
  };
}

/**
 * Create `dir` with mode `0o700` and verify via `lstat()` that it is a real directory
 * owned by the current UID with no group/other bits set (`transport-unix.md` §1.2 step 1).
 */
export function ensureSecurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing unsafe daemon directory (not a real directory): ${dir}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`Refusing daemon directory owned by uid ${stat.uid} (expected ${uid}): ${dir}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    fs.chmodSync(dir, 0o700);
    const rechecked = fs.lstatSync(dir);
    if ((rechecked.mode & 0o077) !== 0) {
      throw new Error(`Refusing daemon directory with permissive mode ${(rechecked.mode & 0o777).toString(8)}: ${dir}`);
    }
  }
}

/**
 * Client pre-connect check (`transport-unix.md` §1.2): verify `dirname(socketPath)` and
 * `socketPath` (when present) are real (not symlinks) and owned by `process.getuid()`.
 */
export function verifySocketOwnership(socketPath: string): void {
  const uid = process.getuid?.();
  const dir = path.dirname(socketPath);
  try {
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error(`Refusing daemon socket directory (not a real directory): ${dir}`);
    }
    if (uid !== undefined && dirStat.uid !== uid) {
      throw new Error(`Refusing daemon socket directory owned by uid ${dirStat.uid}: ${dir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    const sockStat = fs.lstatSync(socketPath);
    if (sockStat.isSymbolicLink() || !sockStat.isSocket()) {
      throw new Error(`Refusing daemon socket path (not a real Unix socket): ${socketPath}`);
    }
    if (uid !== undefined && sockStat.uid !== uid) {
      throw new Error(`Refusing daemon socket owned by uid ${sockStat.uid}: ${socketPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

/** Exclusive SQLite `BEGIN IMMEDIATE` singleton lock (`transport-unix.md` §1.2 step 2). */
function acquireDaemonLock(lockPath: string): () => void {
  ensureSecurePrivateDir(path.dirname(lockPath));
  let database: Database.Database | undefined;
  try {
    database = new Database(lockPath, { timeout: 0 });
    database.exec('BEGIN IMMEDIATE');
  } catch (error) {
    database?.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY') {
      throw new DaemonLockBusyError(lockPath, error);
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      database?.close();
    } catch {
      // Closing on shutdown is best-effort.
    }
  };
}

export function probeSocketConnectable(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * MUST be called ONLY while holding `daemon.lock.sqlite` (`transport-unix.md` §1.2 step 3).
 * Probes existing socket before unlinking; refuses to unlink non-socket files.
 */
export async function prepareSocketForBind(socketPath: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isSocket()) {
    throw new Error(`Refusing to remove non-socket path at daemon socket location: ${socketPath}`);
  }
  if (await probeSocketConnectable(socketPath, 500)) {
    throw new Error(`Active daemon is already listening on ${socketPath}`);
  }
  fs.unlinkSync(socketPath);
}

/** Read process start time (Linux `/proc/self/stat` field 22, or ISO fallback) for advisory `daemon.json`. */
export function readCurrentProcStartTime(): number | string {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync('/proc/self/stat', 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen !== -1) {
        const fields = stat
          .slice(closeParen + 2)
          .trim()
          .split(/\s+/);
        // Field 22 (1-indexed) is index 19 after comm (field 2).
        const startTicks = Number(fields[19]);
        if (Number.isSafeInteger(startTicks)) return startTicks;
      }
    }
  } catch {
    // Fallback to ISO timestamp below.
  }
  return new Date().toISOString();
}

/**
 * Atomically write advisory `daemon.json` via `O_CREAT | O_EXCL | O_NOFOLLOW` mode `0o600` + `rename()`.
 */
export function writeDaemonAdvertisement(advertisementPath: string, info: DaemonAdvertisement): void {
  const dir = path.dirname(advertisementPath);
  const tmpPath = path.join(dir, `.daemon.json.${process.pid}.${Date.now()}.tmp`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(tmpPath, flags, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, advertisementPath);
}

export function removeFileIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

const LOCK_CONTENTION_TIMEOUT_MS = 3_000;

export async function acquireLockOrDetectPeer(
  lockPath: string,
  socketPath: string,
): Promise<{ readonly kind: 'acquired'; readonly release: () => void } | { readonly kind: 'already_running' }> {
  const deadline = Date.now() + LOCK_CONTENTION_TIMEOUT_MS;
  let attempt = 0;
  for (;;) {
    try {
      return { kind: 'acquired', release: acquireDaemonLock(lockPath) };
    } catch (error) {
      if (!(error instanceof DaemonLockBusyError)) throw error;
      if (await probeSocketConnectable(socketPath, 250)) {
        return { kind: 'already_running' };
      }
      if (Date.now() >= deadline) {
        if (await probeSocketConnectable(socketPath, 500)) {
          return { kind: 'already_running' };
        }
        throw new Error(
          `Daemon lock ${lockPath} remained busy for ${LOCK_CONTENTION_TIMEOUT_MS}ms without a live socket.`,
        );
      }
      const backoff = Math.min(200, 25 * Math.pow(2, attempt));
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}
