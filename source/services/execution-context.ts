import { ISSHService } from './service-interfaces.js';
import path from 'path';
import process from 'process';
import { publishActiveWorkspaceRoot } from './workspace/active-workspace-root.js';

/**
 * Owns the single filesystem root every tool resolves against.
 *
 * Tools call `getCwd()` at execution time rather than capturing a root, so
 * re-pointing this object re-points shell, the file tools, and — because the
 * shell sandbox derives its write allowlist from the same value — the set of
 * paths the session may write at all. That is the whole mechanism behind the
 * worktree tools: an *active workspace* is a lease on top of the session's home
 * root, never a mutation of `process.cwd()`, which is process-global and would
 * retarget background jobs already running under the old root.
 */
export class ExecutionContext {
  private activeWorkspace?: string;
  /** A pinned context owns its home and never publishes a process-wide lease. */
  private pinnedHome?: string;

  constructor(private readonly sshService?: ISSHService, private readonly remoteDir?: string) {}

  isRemote(): boolean {
    return !!this.sshService;
  }

  getSSHService(): ISSHService | undefined {
    return this.sshService;
  }

  getCwd(): string {
    if (this.isRemote() && this.remoteDir) {
      return this.remoteDir;
    }
    return this.activeWorkspace ?? this.pinnedHome ?? process.cwd();
  }

  /** The root the session started in, regardless of any active workspace lease. */
  getHomeWorkspace(): string {
    if (this.isRemote() && this.remoteDir) {
      return this.remoteDir;
    }
    return this.pinnedHome ?? process.cwd();
  }

  /** The leased root, or undefined when the session is operating in its home root. */
  getActiveWorkspace(): string | undefined {
    return this.activeWorkspace;
  }

  /**
   * Leases `root` as the active workspace. Callers are responsible for
   * validating that the path is a real, resolved working tree; this class only
   * enforces the invariants that make the root unambiguous.
   */
  enterWorkspace(root: string): void {
    if (this.isRemote()) {
      throw new Error('Cannot enter a local workspace in remote mode: the remote directory owns the execution root.');
    }
    if (!path.isAbsolute(root)) {
      throw new Error(`Active workspace must be an absolute path, received: ${root}`);
    }
    if (this.pinnedHome === undefined) publishActiveWorkspaceRoot(root);
    this.activeWorkspace = root;
  }

  /** Releases the lease, returning the session to its home root. */
  exitWorkspace(): void {
    if (this.pinnedHome === undefined) publishActiveWorkspaceRoot(undefined);
    this.activeWorkspace = undefined;
  }

  /**
   * Session-local home for a child or concurrent owner. Its worktree lease can
   * change without publishing process-wide state, and exit returns to this home
   * rather than process.cwd(). Snapshot a child's root at admission; never share
   * a mutable parent lease with a running child.
   */
  static pin(root: string): ExecutionContext {
    if (!path.isAbsolute(root)) {
      throw new Error(`Active workspace must be an absolute path, received: ${root}`);
    }
    const ctx = new ExecutionContext();
    ctx.pinnedHome = root;
    return ctx;
  }
}
