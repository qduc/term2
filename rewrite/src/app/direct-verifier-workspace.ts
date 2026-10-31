/** Safe read-only evidence for the independent direct verifier; no commands from a model. */
import { realpath } from 'node:fs/promises';
import {
  readVerificationFile,
  snapshotWorkspace,
  UnsupportedWorkspaceError,
  verificationGit,
  type WorkspaceSnapshot,
} from '../../../source/services/completion-verification/workspace.js';
import type { Workspace } from '../tools/index.js';

/** Match the existing clean read probe's 64k text window for a default evidence bundle. */
export const DEFAULT_DIRECT_VERIFIER_EVIDENCE_CHARS = 64_000;
export type DirectVerifierProbe = {
  readonly id: string;
  readonly description: string;
  readonly content: string;
  readonly complete: boolean;
};
export type DirectVerifierEvidence = {
  readonly probes: readonly DirectVerifierProbe[];
  readonly limitations: readonly string[];
  readonly omittedFiles: readonly string[];
};

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

/**
 * Host probes only: safe Git diff and safe regular-file reads, with no shell,
 * repo-selected filters, test runners, tools, approvals or model-supplied argv.
 * The existing helpers enforce root containment and their own artifact bounds.
 * Budget omissions/truncation are explicit and prohibit PASS in the caller.
 */
export async function collectDirectVerifierEvidence(deps: {
  readonly snapshot: WorkspaceSnapshot;
  readonly signal: AbortSignal;
  readonly maxEvidenceChars: number;
  /** Optional extra criterion-relevant files selected by the trusted host, not the worker/model. */
  readonly evidenceFiles?: readonly string[];
}): Promise<DirectVerifierEvidence> {
  let remaining = deps.maxEvidenceChars;
  const probes: DirectVerifierProbe[] = [];
  const limitations: string[] = [];
  const omittedFiles: string[] = [];
  const append = (description: string, content: string, complete = true): void => {
    // Count descriptions as well as bodies; one giant filename cannot bypass the bound.
    const needed = description.length + content.length;
    const allowed = Math.max(0, remaining - description.length);
    const kept = content.slice(0, allowed);
    const fits = needed <= remaining;
    if (remaining < description.length) {
      limitations.push('Evidence budget exhausted before another probe could be included');
      return;
    }
    remaining -= description.length + kept.length;
    probes.push({ id: `probe-${probes.length + 1}`, description, content: kept, complete: complete && fits });
    if (!fits || !complete) limitations.push(`Incomplete evidence: ${description}`);
  };
  assertDirectVerifierActive(deps.signal);
  const diff = await verificationGit(
    deps.snapshot.environment,
    ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--'],
    deps.signal,
  );
  append('git diff --no-ext-diff --no-textconv --binary HEAD --', diff);
  if (diff.includes('GIT binary patch') || diff.includes('Binary files ')) {
    limitations.push('Binary change semantics cannot be established by this text-only verifier');
  }
  const files = [...new Set([...(deps.evidenceFiles ?? []), ...deps.snapshot.files])];
  for (const file of files) {
    assertDirectVerifierActive(deps.signal);
    const description = `read_file ${file}`;
    if (remaining <= description.length) {
      omittedFiles.push(file);
      continue;
    }
    try {
      const content = await readVerificationFile(deps.snapshot.environment, file);
      assertDirectVerifierActive(deps.signal);
      if (content.includes('\0') || content.includes('\uFFFD')) {
        append(description, 'File is not supported as complete UTF-8 text evidence.', false);
        continue;
      }
      // The reused read helper returns at most 64k chars. At its boundary we
      // cannot attest completeness, so expose that uncertainty rather than PASS.
      append(description, content, content.length < 64_000);
    } catch (error) {
      assertDirectVerifierActive(deps.signal);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // A missing/deleted path is a real observation, not manufactured file content.
        append(
          description,
          'Read failed with ENOENT: this path has no readable target. Interpret with the diff; this does not prove whether a dangling symlink exists.',
        );
      } else {
        append(description, 'File read unavailable; no content was inspected.', false);
      }
    }
  }
  if (omittedFiles.length)
    limitations.push(
      `${omittedFiles.length} file(s) omitted by the evidence budget; changed paths remain in the host workspace snapshot`,
    );
  if (!diff && probes.every((probe) => probe.description.startsWith('git diff '))) {
    limitations.push('No changed-file contents or host-selected criterion files were available to inspect');
  }
  return { probes, limitations, omittedFiles };
}
