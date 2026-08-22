import process from 'process';

/**
 * The session's current filesystem root, for code that cannot reach an
 * {@link ExecutionContext}.
 *
 * Threading the context through every pure path utility would touch a wide call
 * graph for no gain, so those utilities keep defaulting to a process-wide root —
 * but that root has to follow an `enter_worktree` lease, or command-safety
 * classification, workspace-membership checks, and path completion all keep
 * describing the main checkout while edits land in the worktree.
 *
 * Exactly one writer: `ExecutionContext.enterWorkspace`/`exitWorkspace`. An
 * explicitly injected root always wins over this fallback.
 */
let activeRoot: string | undefined;
let liveSessionRuntimeCount = 0;

export class ConcurrentWorkspaceRootError extends Error {
  readonly code = 'workspace_root_multi_runtime';

  constructor() {
    super('Cannot publish an active workspace root while multiple session runtimes are live.');
    this.name = 'ConcurrentWorkspaceRootError';
  }
}

/** Internal lifecycle admission used to fail closed before a second runtime retargets tools. */
export function registerSessionRuntime(): () => void {
  liveSessionRuntimeCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    liveSessionRuntimeCount = Math.max(0, liveSessionRuntimeCount - 1);
  };
}

/** Called only by ExecutionContext, which owns the lease. */
export function publishActiveWorkspaceRoot(root: string | undefined): void {
  if (root !== undefined && liveSessionRuntimeCount > 1) {
    throw new ConcurrentWorkspaceRootError();
  }
  activeRoot = root;
}

/** The leased root when a worktree is active, otherwise the process cwd. */
export function getActiveWorkspaceRoot(): string {
  return activeRoot ?? process.cwd();
}
