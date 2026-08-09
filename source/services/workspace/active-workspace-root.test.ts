import { it, expect, afterEach } from 'vitest';
import { getActiveWorkspaceRoot, publishActiveWorkspaceRoot } from './active-workspace-root.js';
import { ExecutionContext } from '../execution-context.js';

afterEach(() => {
  publishActiveWorkspaceRoot(undefined);
});

it('falls back to the process cwd when no workspace is leased', () => {
  expect(getActiveWorkspaceRoot()).toBe(process.cwd());
});

it('entering a workspace publishes the leased root to code that cannot reach the context', () => {
  new ExecutionContext().enterWorkspace('/repo/.worktrees/feature');

  expect(getActiveWorkspaceRoot()).toBe('/repo/.worktrees/feature');
});

it('exiting a workspace restores the process cwd for those callers', () => {
  const context = new ExecutionContext();
  context.enterWorkspace('/repo/.worktrees/feature');
  context.exitWorkspace();

  expect(getActiveWorkspaceRoot()).toBe(process.cwd());
});

it('does not publish a root when entry is rejected', () => {
  expect(() => new ExecutionContext().enterWorkspace('relative/path')).toThrow();

  expect(getActiveWorkspaceRoot()).toBe(process.cwd());
});
