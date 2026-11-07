import process from 'process';
import { AsyncLocalStorage } from 'node:async_hooks';

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
 * A session-scoped root takes precedence when supplied. Otherwise exactly one
 * writer, `ExecutionContext.enterWorkspace`/`exitWorkspace`, owns the legacy
 * process-wide fallback. An explicitly injected root wins over either.
 */
const scopedRoot = new AsyncLocalStorage<() => string>();

/** Bind source filesystem helpers to one session without publishing a process-wide lease. */
export function withActiveWorkspaceRoot<T>(root: () => string, operation: () => T): T {
  return scopedRoot.run(root, operation);
}

let activeRoot: string | undefined;
const liveSessionRuntimeCount = 0;

class ConcurrentWorkspaceRootError extends Error {
  readonly code = 'workspace_root_multi_runtime';

  constructor() {
    super('Cannot publish an active workspace root while multiple session runtimes are live.');
    this.name = 'ConcurrentWorkspaceRootError';
  }
}

/** Called only by ExecutionContext, which owns the lease. */
export function publishActiveWorkspaceRoot(root: string | undefined): void {
  if (root !== undefined && liveSessionRuntimeCount > 1) {
    throw new ConcurrentWorkspaceRootError();
  }
  activeRoot = root;
}

/** The scoped session root, or the legacy leased root, or the process cwd. */
export function getActiveWorkspaceRoot(): string {
  return scopedRoot.getStore()?.() ?? activeRoot ?? process.cwd();
}
