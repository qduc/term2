import { stderr, stdout } from 'node:process';

let settled: number | undefined;

/** The code a pending {@link exitAfterDrain} will exit with, or undefined before one starts. */
export function settledExitCode(): number | undefined {
  return settled;
}

/** Resolves once every write queued on `stream` so far has reached the OS, or the stream has failed. */
function drained(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return Promise.resolve();
  // Writes complete in order, so an empty write's callback runs after every earlier one.
  return new Promise((resolve) => stream.write('', () => resolve()));
}

/**
 * Exit with `code` once stdout and stderr have drained.
 *
 * `process.exit` discards writes still queued on a pipe: with a slow reader a
 * headless `--json` run exited 0 with its `final` record cut mid-line and no
 * `run_summary` or `completed` after it. A reader that never reads keeps the
 * process waiting, as any blocking writer would; a signal handler that sees
 * {@link settledExitCode} should exit with it rather than a signal code, so a
 * late signal cannot override the result.
 */
export async function exitAfterDrain(code: number): Promise<never> {
  settled = code;
  await Promise.all([drained(stdout), drained(stderr)]);
  process.exit(code);
}
