import { mkdir, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import path from 'path';
import { getTrimConfig, trimOutput } from '../output/output-trim.js';
import { SANDBOX_TEMP_DIR } from './temp-dir.js';

export interface FormatShellExecutionOutputParams {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  maxOutputLength?: number;
  /** Retained data lines per stream; status and omission/artifact notes are extra. */
  maxOutputLines?: number;
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

interface ArtifactInputs {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs?: number;
  cancelled?: boolean;
}

/** Lines in `text` as `wc -l` counts a file: newline characters, plus an unterminated last line. */
export function countFileLines(text: string): number {
  if (text === '') return 0;
  let count = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count++;
  return text.endsWith('\n') ? count : count + 1;
}

/** Lines of the spooled file at which each captured stream starts (1-based), and the file's total. */
export interface ArtifactLayout {
  stdoutFirstLine: number;
  stderrFirstLine: number;
  totalLines: number;
}

function buildArtifact(params: ArtifactInputs): { contents: string; layout: ArtifactLayout } {
  const statusLine = params.cancelled ? 'cancelled' : params.timedOut ? 'timeout' : `exit ${params.exitCode ?? 'null'}`;
  const timedOutColumn = params.timedOut && !params.cancelled ? 'yes' : 'no';
  const header = [
    `Command: ${params.command}`,
    `Working directory: ${params.cwd}`,
    `Status: ${statusLine}`,
    typeof params.durationMs === 'number' ? `Runtime: ${params.durationMs}ms` : undefined,
    `Timed out: ${timedOutColumn}`,
    '',
    'STDOUT:',
  ].map((line) => line ?? '');
  const stdout = params.stdout || '(empty)';
  const stderr = params.stderr || '(empty)';
  // Joined with newlines below: each element after the header occupies its own line(s).
  const stdoutFirstLine = header.join('\n').split('\n').length + 1;
  const stderrFirstLine = stdoutFirstLine + stdout.split('\n').length + 2;
  const contents = [...header, stdout, '', 'STDERR:', stderr, ''].join('\n');
  return { contents, layout: { stdoutFirstLine, stderrFirstLine, totalLines: countFileLines(contents) } };
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
export function formatFullOutputSavedNote(artifactPath: string, totalLines?: number): string {
  const size = totalLines ? ` (${totalLines} line${totalLines === 1 ? '' : 's'})` : '';
  return `${FULL_OUTPUT_SAVED_NOTE_PREFIX} \`${artifactPath}\`${size}`;
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

/**
 * Bound each captured stream without changing execution status. Blank lines count;
 * a final newline is a delimiter, not another line. Small budgets retain head/tail
 * data rather than inheriting trimOutput's ten-line minimum. Characters remain
 * independently bounded, and the formatter spools the original streams on loss.
 */
function trimShellOutput(
  output: string,
  maxOutputLines: number,
  maxOutputLength: number | undefined,
  /**
   * Where this stream sits in the spooled file. When given, the marker names the trimmed range in the file's
   * own line numbers; when absent it states only how many lines were trimmed.
   */
  file?: () => { firstLine: number; totalLines: number },
): { text: string; exact: boolean } {
  const lines = output === '' ? [] : output.split('\n');
  if (output.endsWith('\n')) lines.pop();
  let lineBounded = output;
  let ranged = false;
  if (lines.length > maxOutputLines) {
    const keepLines = Math.max(1, Math.floor(maxOutputLines * 0.4));
    const headCount = Math.min(keepLines, maxOutputLines);
    const tailCount = Math.min(keepLines, maxOutputLines - headCount);
    let marker = `... [${lines.length - headCount - tailCount} lines trimmed] ...`;
    if (file) {
      const { firstLine, totalLines } = file();
      marker = `... [lines ${firstLine + headCount}-${
        firstLine + lines.length - tailCount - 1
      } of ${totalLines} trimmed] ...`;
      ranged = true;
    }
    lineBounded = [...lines.slice(0, headCount), marker, ...(tailCount > 0 ? lines.slice(-tailCount) : [])].join('\n');
  }
  const text = trimOutput(lineBounded, Number.POSITIVE_INFINITY, maxOutputLength);
  // A character bound that fires re-cuts the already-marked text, so its numbers no longer describe the file.
  return { text, exact: !ranged || text === lineBounded };
}

export async function formatShellExecutionOutput({
  command,
  cwd,
  stdout,
  stderr,
  exitCode,
  timedOut,
  maxOutputLength,
  maxOutputLines = getTrimConfig().maxLines,
  durationMs,
  timeoutMs,
  timeoutSource,
  cancelled,
}: FormatShellExecutionOutputParams): Promise<FormatShellExecutionOutputResult> {
  // The spooled file is built (and its layout known) only once a stream actually needs trimming.
  let artifact: ReturnType<typeof buildArtifact> | undefined;
  const spooled = () =>
    (artifact ??= buildArtifact({ command, cwd, stdout, stderr, exitCode, timedOut, durationMs, cancelled }));
  const statusLine = cancelled ? 'cancelled' : timedOut ? 'timeout' : `exit ${exitCode ?? 'null'}`;
  const runtimeLine = typeof durationMs === 'number' ? `Runtime: ${durationMs}ms` : '';
  const terminationNote = buildTerminationNote({ timedOut, cancelled, timeoutMs, timeoutSource });

  const render = (ranges: boolean) => {
    const place = (first: 'stdoutFirstLine' | 'stderrFirstLine') =>
      ranges ? () => ({ firstLine: spooled().layout[first], totalLines: spooled().layout.totalLines }) : undefined;
    const out = trimShellOutput(stdout, maxOutputLines, maxOutputLength, place('stdoutFirstLine'));
    const err = trimShellOutput(stderr, maxOutputLines, maxOutputLength, place('stderrFirstLine'));
    const combinedOutput = [out.text.trimEnd(), err.text.trimEnd()].filter(Boolean).join('\n').trimEnd();
    const emptyOutputNote = combinedOutput === '' && !timedOut && !cancelled && exitCode === 0 ? '(No output)' : '';
    return {
      truncated: out.text !== stdout || err.text !== stderr,
      exact: out.exact && err.exact,
      body: (note: string) =>
        [statusLine, runtimeLine, terminationNote, combinedOutput, emptyOutputNote, note].filter(Boolean).join('\n'),
    };
  };

  // Range markers state the spooled file's own line numbers, so they are used only when nothing after them
  // re-cuts the text: no character bound re-trimmed a marked stream, and the finished result (with its spool
  // note) is within the limits the generic tool-result trim applies afterwards. Otherwise only counts are given.
  let rendered = render(true);
  if (rendered.truncated && rendered.exact) {
    const cfg = getTrimConfig();
    const charLimit = Math.min(maxOutputLength ?? Number.POSITIVE_INFINITY, cfg.maxCharacters);
    const probe = rendered.body(formatFullOutputSavedNote('x'.repeat(200), spooled().layout.totalLines));
    if (probe.split('\n').length > cfg.maxLines || probe.length > charLimit) rendered = render(false);
  } else if (rendered.truncated) {
    rendered = render(false);
  }

  let artifactPath: string | undefined;
  if (rendered.truncated) {
    artifactPath = await saveOutputArtifact(spooled().contents);
  }

  const truncationNote = artifactPath ? formatFullOutputSavedNote(artifactPath, spooled().layout.totalLines) : '';

  return {
    text: rendered.body(truncationNote),
    truncated: Boolean(artifactPath),
    artifactPath,
  };
}
