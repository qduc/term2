import { it, expect } from 'vitest';
import { createWorktreeToolDefinitions } from './worktree.js';
import { ExecutionContext } from '../../services/execution-context.js';
import type { GitWorktree } from '../../services/workspace/parse-worktree-list.js';
import type { RunningJob } from '../../services/workspace/worktree-transition.js';

const HOME = process.cwd();
const FEATURE = `${HOME}/.worktrees/feature`;

function worktree(path: string, branch?: string, overrides: Partial<GitWorktree> = {}): GitWorktree {
  return { path, branch, detached: false, bare: false, locked: false, prunable: false, ...overrides };
}

function build(options: { worktrees?: GitWorktree[]; runningJobs?: RunningJob[] } = {}) {
  const executionContext = new ExecutionContext();
  const tools = createWorktreeToolDefinitions({
    executionContext,
    listWorktrees: async () => options.worktrees ?? [worktree(HOME, 'main'), worktree(FEATURE, 'feature')],
    getRunningJobs: () => options.runningJobs ?? [],
  });
  return { executionContext, ...tools };
}

it('enter_worktree re-roots the execution context at the named worktree', async () => {
  const { enter, executionContext } = build();

  await enter.execute({ name: 'feature' });

  expect(executionContext.getCwd()).toBe(FEATURE);
  expect(executionContext.getActiveWorkspace()).toBe(FEATURE);
});

it('enter_worktree leaves the root untouched when the name is unknown', async () => {
  const { enter, executionContext } = build();

  const output = await enter.execute({ name: 'nope' });

  expect(executionContext.getCwd()).toBe(HOME);
  expect(String(output)).toContain('feature');
});

it('enter_worktree reports the available worktrees when the name is unknown', async () => {
  const { enter } = build();

  expect(String(await enter.execute({ name: 'nope' }))).toMatch(/not found/i);
});

it('enter_worktree refuses while a background job is running, naming the job', async () => {
  const { enter, executionContext } = build({ runningJobs: [{ id: 'job-1', command: 'pnpm test' }] });

  const output = String(await enter.execute({ name: 'feature' }));

  expect(executionContext.getCwd()).toBe(HOME);
  expect(output).toContain('job-1');
  expect(output).toContain('pnpm test');
});

it('enter_worktree refuses an ambiguous directory name without switching', async () => {
  const { enter, executionContext } = build({
    worktrees: [
      worktree(HOME, 'main'),
      worktree(`${HOME}/.worktrees/a/dup`, 'branch-a'),
      worktree(`${HOME}/.worktrees/b/dup`, 'branch-b'),
    ],
  });

  const output = String(await enter.execute({ name: 'dup' }));

  expect(executionContext.getCwd()).toBe(HOME);
  expect(output).toMatch(/ambiguous/i);
  expect(output).toContain('branch-a');
});

it('exit_worktree returns the session to its home root', async () => {
  const { enter, exit, executionContext } = build();
  await enter.execute({ name: 'feature' });

  await exit.execute({});

  expect(executionContext.getCwd()).toBe(HOME);
  expect(executionContext.getActiveWorkspace()).toBeUndefined();
});

it('exit_worktree refuses while a background job is running under the worktree', async () => {
  const jobs: RunningJob[] = [];
  const executionContext = new ExecutionContext();
  const { enter, exit } = createWorktreeToolDefinitions({
    executionContext,
    listWorktrees: async () => [worktree(HOME, 'main'), worktree(FEATURE, 'feature')],
    getRunningJobs: () => jobs,
  });
  await enter.execute({ name: 'feature' });
  jobs.push({ id: 'job-9', command: 'pnpm build' });

  const output = String(await exit.execute({}));

  expect(executionContext.getCwd()).toBe(FEATURE);
  expect(output).toContain('job-9');
});

it('exit_worktree is a no-op that says so when no worktree is active', async () => {
  const { exit, executionContext } = build();

  expect(String(await exit.execute({}))).toMatch(/not in a worktree/i);
  expect(executionContext.getCwd()).toBe(HOME);
});

it('neither tool requires approval, since targets come from a runtime-issued list', async () => {
  const { enter, exit } = build();

  expect(await enter.needsApproval({ name: 'feature' })).toBe(false);
  expect(await exit.needsApproval({})).toBe(false);
});
