import { mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { trimOutput } from '../output/output-trim.js';

export interface FormatShellExecutionOutputParams {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  maxOutputLength?: number;
  durationMs?: number;
}

export interface FormatShellExecutionOutputResult {
  text: string;
  truncated: boolean;
  artifactPath?: string;
}

const TRUNCATED_NOTE_PREFIX = 'Full shell output saved to';

function buildArtifactContents(params: {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs?: number;
}): string {
  const statusLine = params.timedOut ? 'timeout' : `exit ${params.exitCode ?? 'null'}`;

  return [
    `Command: ${params.command}`,
    `Working directory: ${params.cwd}`,
    `Status: ${statusLine}`,
    typeof params.durationMs === 'number' ? `Runtime: ${params.durationMs}ms` : undefined,
    `Timed out: ${params.timedOut ? 'yes' : 'no'}`,
    '',
    'STDOUT:',
    params.stdout || '(empty)',
    '',
    'STDERR:',
    params.stderr || '(empty)',
    '',
  ].join('\n');
}

async function saveShellOutputArtifact(contents: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'term2-shell-output-'));
  const artifactPath = path.join(tempDir, 'output.txt');
  await writeFile(artifactPath, contents, 'utf8');
  return artifactPath;
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
}: FormatShellExecutionOutputParams): Promise<FormatShellExecutionOutputResult> {
  const stdoutTrimmedOutput = trimOutput(stdout, undefined, maxOutputLength);
  const stderrTrimmedOutput = trimOutput(stderr, undefined, maxOutputLength);
  const stdoutTrimmed = stdoutTrimmedOutput.trimEnd();
  const stderrTrimmed = stderrTrimmedOutput.trimEnd();
  const stdoutTruncated = stdoutTrimmedOutput !== stdout;
  const stderrTruncated = stderrTrimmedOutput !== stderr;
  const combinedOutput = [stdoutTrimmed, stderrTrimmed].filter(Boolean).join('\n').trimEnd();
  const statusLine = timedOut ? 'timeout' : `exit ${exitCode ?? 'null'}`;
  const runtimeLine = typeof durationMs === 'number' ? `Runtime: ${durationMs}ms` : '';
  const emptyOutputNote = combinedOutput === '' && !timedOut && exitCode === 0 ? '(No output)' : '';

  let artifactPath: string | undefined;
  if (stdoutTruncated || stderrTruncated) {
    artifactPath = await saveShellOutputArtifact(
      buildArtifactContents({ command, cwd, stdout, stderr, exitCode, timedOut, durationMs }),
    );
  }

  const truncationNote = artifactPath
    ? `${TRUNCATED_NOTE_PREFIX} \`${artifactPath}\`. Search that file for what you need instead of rerunning the command or changing the filter criteria with a \`| grep\` pipeline.`
    : '';

  return {
    text: [statusLine, runtimeLine, combinedOutput, emptyOutputNote, truncationNote].filter(Boolean).join('\n'),
    truncated: Boolean(artifactPath),
    artifactPath,
  };
}
