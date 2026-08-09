import { z } from 'zod';
import path from 'path';
import type { ToolDefinition } from '../types.js';
import type { ExecutionContext } from '../../services/execution-context.js';
import type { GitWorktree } from '../../services/workspace/parse-worktree-list.js';
import { listGitWorktrees, type ListWorktrees } from '../../services/workspace/worktree-inventory.js';
import {
  enterableWorktrees,
  resolveEnterWorktree,
  resolveExitWorktree,
  type RunningJob,
} from '../../services/workspace/worktree-transition.js';
import { getCallIdFromItem, getOutputText, normalizeToolArguments, createBaseMessage } from '../format-helpers.js';

const ENTER_WORKTREE_DESCRIPTION =
  "Switch this session into one of the repository's existing git worktrees. Every subsequent shell command, file read, and file edit resolves against that worktree instead of the main checkout, and the shell sandbox only permits writes there. " +
  'Use this immediately after creating a worktree for a task, before making any edits — creating a worktree with `git worktree add` does NOT move you into it, and edits made without this tool land in the main checkout. ' +
  'Identify the worktree by its directory name or its branch name; call with an unknown name to see the available list. ' +
  'Use exit_worktree to return to the main checkout. Approvals granted in one worktree do not carry over to another.';

const EXIT_WORKTREE_DESCRIPTION =
  'Return this session to the main checkout it started in, undoing enter_worktree. Subsequent commands, reads, and edits resolve against the main checkout again. ' +
  'Use this when work in the worktree is committed and you need to merge it back, or when the task that owned the worktree is finished.';

const enterWorktreeSchema = z.object({
  name: z
    .string()
    .describe('Directory name or branch name of an existing worktree. Call with an unknown name to list the options.'),
});

const exitWorktreeSchema = z.object({});

export interface WorktreeToolDependencies {
  executionContext: ExecutionContext;
  /** Injected in tests; defaults to shelling out to `git worktree list`. */
  listWorktrees?: ListWorktrees;
  /** Background shell jobs still running under the current root. */
  getRunningJobs: () => RunningJob[];
}

function describeWorktree(worktree: GitWorktree): string {
  const name = path.basename(worktree.path);
  const label = worktree.branch ? `${name} (branch ${worktree.branch})` : `${name} (detached)`;
  return `  - ${label}\n    ${worktree.path}`;
}

function describeJobs(jobs: RunningJob[]): string {
  return jobs.map((job) => `  - ${job.id}: ${job.command}`).join('\n');
}

function busyMessage(action: string, jobs: RunningJob[]): string {
  return (
    `Refused to ${action}: ${jobs.length} background shell job(s) are still running under the current root.\n` +
    `${describeJobs(jobs)}\n\n` +
    'These jobs captured their working directory when they launched, so switching now would leave them writing to the old root. ' +
    'Wait for them to finish or cancel them, then retry.'
  );
}

export function createWorktreeToolDefinitions(dependencies: WorktreeToolDependencies): {
  enter: ToolDefinition<typeof enterWorktreeSchema>;
  exit: ToolDefinition<typeof exitWorktreeSchema>;
} {
  const { executionContext, listWorktrees = listGitWorktrees, getRunningJobs } = dependencies;

  const enter: ToolDefinition<typeof enterWorktreeSchema> = {
    name: 'enter_worktree',
    description: ENTER_WORKTREE_DESCRIPTION,
    parameters: enterWorktreeSchema,
    needsApproval: () => false,
    execute: async (params) => {
      const homeRoot = executionContext.getHomeWorkspace();

      let worktrees: GitWorktree[];
      try {
        worktrees = await listWorktrees(homeRoot);
      } catch (error: any) {
        return `Error: could not list worktrees (${error?.message ?? error}). Is ${homeRoot} inside a git repository?`;
      }

      const outcome = resolveEnterWorktree({
        name: params.name,
        homeRoot,
        worktrees,
        activeWorkspace: executionContext.getActiveWorkspace(),
        runningJobs: getRunningJobs(),
      });

      switch (outcome.kind) {
        case 'entered':
          executionContext.enterWorkspace(outcome.worktree.path);
          return (
            `Entered worktree ${path.basename(outcome.worktree.path)}${
              outcome.worktree.branch ? ` (branch ${outcome.worktree.branch})` : ''
            }.\n` +
            `All shell commands, reads, and edits now resolve against ${outcome.worktree.path}.\n` +
            'Use exit_worktree to return to the main checkout.'
          );

        case 'already_active':
          return `Already in worktree ${path.basename(outcome.worktree.path)} (${outcome.worktree.path}). No change.`;

        case 'not_found': {
          if (outcome.available.length === 0) {
            return (
              `Worktree '${params.name}' not found, and this repository has no worktrees besides the main checkout.\n` +
              'Create one with `git worktree add .worktrees/<slug> -b <slug>`, then call enter_worktree again.'
            );
          }
          return `Worktree '${params.name}' not found. Available worktrees:\n${outcome.available
            .map(describeWorktree)
            .join('\n')}`;
        }

        case 'ambiguous':
          return (
            `Worktree name '${params.name}' is ambiguous — it matches ${outcome.candidates.length} worktrees:\n` +
            `${outcome.candidates.map(describeWorktree).join('\n')}\n\n` +
            'Call enter_worktree again with the branch name to disambiguate.'
          );

        case 'unavailable':
          return (
            `Worktree '${params.name}' is registered at ${outcome.worktree.path} but its directory is missing. ` +
            'Run `git worktree prune` to clear the stale record, or recreate the worktree.'
          );

        case 'busy':
          return busyMessage(`enter worktree '${params.name}'`, outcome.jobs);
      }
    },
    formatCommandMessage: (item, index, toolCallArgumentsById) => {
      const callId = getCallIdFromItem(item);
      const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
      const args =
        normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ??
        normalizeToolArguments(fallbackArgs) ??
        {};
      const output = getOutputText(item) || '';

      return [
        createBaseMessage(item, index, 0, false, {
          command: `enter_worktree "${args?.name ?? 'unknown'}"`,
          output,
          success: output.startsWith('Entered') || output.startsWith('Already in'),
          toolName: 'enter_worktree',
          toolArgs: args,
        }),
      ];
    },
  };

  const exit: ToolDefinition<typeof exitWorktreeSchema> = {
    name: 'exit_worktree',
    description: EXIT_WORKTREE_DESCRIPTION,
    parameters: exitWorktreeSchema,
    needsApproval: () => false,
    execute: async () => {
      const outcome = resolveExitWorktree({
        homeRoot: executionContext.getHomeWorkspace(),
        activeWorkspace: executionContext.getActiveWorkspace(),
        runningJobs: getRunningJobs(),
      });

      switch (outcome.kind) {
        case 'exited':
          executionContext.exitWorkspace();
          return `Left the worktree. All shell commands, reads, and edits now resolve against ${outcome.homeRoot}.`;

        case 'not_in_worktree':
          return `Not in a worktree — the session is already in its main checkout (${outcome.homeRoot}). No change.`;

        case 'busy':
          return busyMessage('exit the worktree', outcome.jobs);
      }
    },
    formatCommandMessage: (item, index) => {
      const output = getOutputText(item) || '';
      return [
        createBaseMessage(item, index, 0, false, {
          command: 'exit_worktree',
          output,
          success: output.startsWith('Left') || output.startsWith('Not in a worktree'),
          toolName: 'exit_worktree',
          toolArgs: {},
        }),
      ];
    },
  };

  return { enter, exit };
}

export { enterableWorktrees };
