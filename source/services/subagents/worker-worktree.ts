import path from 'node:path';
import { ExecutionContext } from '../execution-context.js';
import { listGitWorktrees, type ListWorktrees } from '../workspace/worktree-inventory.js';
import { resolveWorkerWorktree, type ResolveWorkerWorktreeOutcome } from '../workspace/worktree-transition.js';
import type { GitWorktree } from '../workspace/parse-worktree-list.js';

export type WorkerWorktreePin =
  | { ok: true; executionContext: ExecutionContext; worktreePath: string; worktree: GitWorktree }
  | { ok: false; error: string };

function describeAvailable(worktrees: GitWorktree[]): string {
  if (worktrees.length === 0) {
    return 'No enterable worktrees exist. Create one under the workspace root with `git worktree add .worktrees/<slug> -b <slug>`, then retry with worktree set to that slug or branch.';
  }
  return (
    'Available worktrees:\n' +
    worktrees
      .map((worktree) => {
        const name = path.basename(worktree.path);
        return worktree.branch ? `  - ${name} (branch ${worktree.branch})` : `  - ${name} (detached)`;
      })
      .join('\n')
  );
}

function formatResolveFailure(
  name: string,
  outcome: Exclude<ResolveWorkerWorktreeOutcome, { kind: 'resolved' }>,
): string {
  switch (outcome.kind) {
    case 'not_found':
      return `Unknown worktree "${name}". ${describeAvailable(outcome.available)}`;
    case 'ambiguous':
      return (
        `Ambiguous worktree name "${name}" matches ${outcome.candidates.length} trees. ` +
        'Use the branch name to disambiguate:\n' +
        outcome.candidates
          .map((worktree) => {
            const dir = path.basename(worktree.path);
            return worktree.branch ? `  - ${dir} (branch ${worktree.branch})` : `  - ${dir}`;
          })
          .join('\n')
      );
    case 'unavailable':
      return `Worktree "${name}" is prunable (directory missing at ${outcome.worktree.path}). Recreate it or choose another worktree.`;
  }
}

/**
 * Resolves an existing worktree by name and returns a run-local
 * {@link ExecutionContext.pin} for a worker subagent. Never re-roots the
 * parent session or publishes the process-wide active workspace.
 */
export async function pinWorkerWorktree(params: {
  name: string;
  role: string;
  homeRoot: string;
  isRemote: boolean;
  listWorktrees?: ListWorktrees;
}): Promise<WorkerWorktreePin> {
  const { name, role, homeRoot, isRemote, listWorktrees = listGitWorktrees } = params;

  if (role !== 'worker') {
    return {
      ok: false,
      error: `worktree is only supported for role "worker" (received "${role}"). Omit worktree or use role "worker".`,
    };
  }
  if (isRemote) {
    return {
      ok: false,
      error: 'worktree pinning is not available in remote mode: the remote directory owns the execution root.',
    };
  }

  let worktrees: GitWorktree[];
  try {
    worktrees = await listWorktrees(homeRoot);
  } catch (error: any) {
    return {
      ok: false,
      error: `Could not list worktrees (${error?.message ?? error}). Is ${homeRoot} inside a git repository?`,
    };
  }

  const outcome = resolveWorkerWorktree(name, homeRoot, worktrees);
  if (outcome.kind !== 'resolved') {
    return { ok: false, error: formatResolveFailure(name, outcome) };
  }

  return {
    ok: true,
    executionContext: ExecutionContext.pin(outcome.worktree.path),
    worktreePath: outcome.worktree.path,
    worktree: outcome.worktree,
  };
}
