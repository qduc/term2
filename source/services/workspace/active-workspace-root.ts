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

/** Called only by ExecutionContext, which owns the lease. */
export function publishActiveWorkspaceRoot(root: string | undefined): void {
  activeRoot = root;
}

/** The leased root when a worktree is active, otherwise the process cwd. */
export function getActiveWorkspaceRoot(): string {
  return activeRoot ?? process.cwd();
}
