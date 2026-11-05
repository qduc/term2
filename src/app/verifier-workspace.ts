/** Workspace authority and snapshots for the independent direct verifier. */
import { realpath } from 'node:fs/promises';
import {
  snapshotWorkspace,
  UnsupportedWorkspaceError,
  verificationGit,
  type WorkspaceSnapshot,
} from '../engine/completion-verification/workspace.js';
import type { Workspace } from '../tools/index.js';

/** Check between non-abortable filesystem reads too; never return a cancelled PASS. */
export function assertDirectVerifierActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Independent verification cancelled');
}

/**
 * Only a local authorized repository ROOT can be snapshotted: discovering a Git
 * root above a narrower grant is not permission to inspect it. Run this before
 * snapshotWorkspace, which otherwise deliberately inspects the whole project.
 */
export async function directVerifierRoot(workspace: Workspace, signal: AbortSignal): Promise<string> {
  assertDirectVerifierActive(signal);
  if (workspace.target !== 'local')
    throw new UnsupportedWorkspaceError(
      'remote-verification-unsupported',
      'Independent direct verification requires an authorized local workspace',
    );
  const root = await realpath(workspace.root);
  const repository = await verificationGit(root, ['rev-parse', '--show-toplevel'], signal);
  assertDirectVerifierActive(signal);
  if ((await realpath(repository.trim())) !== root)
    throw new UnsupportedWorkspaceError(
      'partial-workspace-unsupported',
      'Independent verification cannot broaden a subdirectory grant to its repository root',
    );
  return root;
}

/** Reuse the existing exact HEAD + dirty diff + untracked-content revision contract. */
export async function takeDirectVerifierSnapshot(
  workspace: Workspace,
  signal: AbortSignal,
): Promise<WorkspaceSnapshot> {
  const root = await directVerifierRoot(workspace, signal);
  assertDirectVerifierActive(signal);
  // The clean helper has bounded Git subprocesses but no aggregate signal
  // argument. Await real cleanup, then honor cancellation; never race it loose.
  const snapshot = await snapshotWorkspace(root);
  assertDirectVerifierActive(signal);
  if (snapshot.environment !== root) throw new Error('Authorized repository root changed during snapshot');
  return snapshot;
}

/** A request environment is data, not authority to read a different workspace. */
export async function assertDirectVerifierEnvironment(
  workspace: Workspace,
  environment: string,
  signal: AbortSignal,
): Promise<string> {
  const root = await directVerifierRoot(workspace, signal);
  if ((await realpath(environment)) !== root)
    throw new UnsupportedWorkspaceError(
      'verification-environment-mismatch',
      'Verification request environment differs from the authorized workspace',
    );
  assertDirectVerifierActive(signal);
  return root;
}
