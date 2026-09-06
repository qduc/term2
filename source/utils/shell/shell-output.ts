import { mkdir, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import path from 'path';
import { trimOutput } from '../output/output-trim.js';
import { SANDBOX_TEMP_DIR } from './temp-dir.js';

export interface FormatShellExecutionOutputParams {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  maxOutputLength?: number;
  durationMs?: number;
  /** Effective deadline budget, for the bounded timeout explanation. */
  timeoutMs?: number;
  /** Where the effective budget came from (invocation vs a settings default). */
  timeoutSource?: 'invocation' | 'foreground_setting' | 'background_setting';
  /** Present when the executor stopped the command for a caller cancellation. */
  cancelled?: boolean;
}

export interface FormatShellExecutionOutputResult {
  text: string;
  truncated: boolean;
  artifactPath?: string;
}

/** Load-bearing prose: the agent reads this path back with an ordinary file read. */
export const FULL_OUTPUT_SAVED_NOTE_PREFIX = 'Full output saved to';

const TOOL_OUTPUT_DIR = path.join(SANDBOX_TEMP_DIR, 'tool-output');
let toolOutputDirPromise: Promise<string> | undefined;

function buildArtifactContents(params: {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs?: number;
  cancelled?: boolean;
}): string {
  const statusLine = params.cancelled ? 'cancelled' : params.timedOut ? 'timeout' : `exit ${params.exitCode ?? 'null'}`;
  const timedOutColumn = params.timedOut && !params.cancelled ? 'yes' : 'no';

  return [
    `Command: ${params.command}`,
    `Working directory: ${params.cwd}`,
    `Status: ${statusLine}`,
    typeof params.durationMs === 'number' ? `Runtime: ${params.durationMs}ms` : undefined,
    `Timed out: ${timedOutColumn}`,
    '',
    'STDOUT:',
    params.stdout || '(empty)',
    '',
    'STDERR:',
    params.stderr || '(empty)',
    '',
  ].join('\n');
}

/**
 * Spool full tool output to a temp file for later retrieval.
 * Shared by shell, read_file, web_fetch, and other bounded producers.
 */
export async function saveOutputArtifact(contents: string, options?: { filenamePrefix?: string }): Promise<string> {
  toolOutputDirPromise ??= (async () => {
    await mkdir(TOOL_OUTPUT_DIR, { recursive: true, mode: 0o700 });
    return TOOL_OUTPUT_DIR;
  })();
  const tempDir = await toolOutputDirPromise;
  const suffix = randomBytes(3).toString('hex');
  const prefix = options?.filenamePrefix ?? 'output';
  const artifactPath = path.join(tempDir, `${prefix}-${process.pid}-${Date.now()}-${suffix}.txt`);
  await writeFile(artifactPath, contents, 'utf8');
  return artifactPath;
}

/** Build the standard truncation note the agent relies on for follow-up reads. */
export function formatFullOutputSavedNote(artifactPath: string): string {
  return `${FULL_OUTPUT_SAVED_NOTE_PREFIX} \`${artifactPath}\``;
}

/**
 * Bounded, model-facing explanation of why the command stopped. Load-bearing
 * wording (partial effects, no automatic replay) is part of the tool contract:
 * a deadline is evidence the agent must diagnose, not a license to retry a
 * command whose earlier effects may already have landed.
 */
function buildTerminationNote(params: {
  timedOut: boolean;
  cancelled?: boolean;
  timeoutMs?: number;
  timeoutSource?: 'invocation' | 'foreground_setting' | 'background_setting';
}): string {
  if (params.cancelled) {
    return 'Interrupted: the command was cancelled before completing.\nOutput may be partial and effects may already have occurred.';
  }
  if (!params.timedOut) return '';
  const budgetLabel =
    params.timeoutSource === 'invocation'
      ? `its explicit ${params.timeoutMs}ms timeout`
      : params.timeoutSource === 'background_setting'
      ? `the ${params.timeoutMs}ms background-setting timeout`
      : params.timeoutSource === 'foreground_setting'
      ? `the ${params.timeoutMs}ms foreground-setting timeout`
      : params.timeoutMs !== undefined
      ? `its ${params.timeoutMs}ms timeout budget`
      : 'its timeout budget';
  return [
    `Terminated: the command reached the end of ${budgetLabel} and was stopped.`,
    'Output may be partial and effects may already have occurred; increasing the timeout does not authorize replaying the command.',
  ].join('\n');
}

export async function formatShellExecutionOutput({
  command,
  cwd,
  stdout,
  stderr,
  exitCode,
  timedOut,
  maxOutputLength,
  durationMs,
  timeoutMs,
  timeoutSource,
  cancelled,
}: FormatShellExecutionOutputParams): Promise<FormatShellExecutionOutputResult> {
  const stdoutTrimmedOutput = trimOutput(stdout, undefined, maxOutputLength);
  const stderrTrimmedOutput = trimOutput(stderr, undefined, maxOutputLength);
  const stdoutTrimmed = stdoutTrimmedOutput.trimEnd();
  const stderrTrimmed = stderrTrimmedOutput.trimEnd();
  const stdoutTruncated = stdoutTrimmedOutput !== stdout;
  const stderrTruncated = stderrTrimmedOutput !== stderr;
  const combinedOutput = [stdoutTrimmed, stderrTrimmed].filter(Boolean).join('\n').trimEnd();
  const statusLine = cancelled ? 'cancelled' : timedOut ? 'timeout' : `exit ${exitCode ?? 'null'}`;
  const runtimeLine = typeof durationMs === 'number' ? `Runtime: ${durationMs}ms` : '';
  const terminationNote = buildTerminationNote({ timedOut, cancelled, timeoutMs, timeoutSource });
  const emptyOutputNote = combinedOutput === '' && !timedOut && !cancelled && exitCode === 0 ? '(No output)' : '';

  let artifactPath: string | undefined;
  if (stdoutTruncated || stderrTruncated) {
    artifactPath = await saveOutputArtifact(
      buildArtifactContents({ command, cwd, stdout, stderr, exitCode, timedOut, durationMs, cancelled }),
    );
  }

  const truncationNote = artifactPath ? formatFullOutputSavedNote(artifactPath) : '';

  return {
    text: [statusLine, runtimeLine, terminationNote, combinedOutput, emptyOutputNote, truncationNote]
      .filter(Boolean)
      .join('\n'),
    truncated: Boolean(artifactPath),
    artifactPath,
  };
}
