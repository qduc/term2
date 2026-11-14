import { stderr, stdout } from 'node:process';

let settled: number | undefined;

/** The code a pending {@link exitAfterDrain} will exit with, or undefined before one starts. */
export function settledExitCode(): number | undefined {
  return settled;
}

/** Resolves once every write queued on `stream` so far has reached the OS, or the stream has failed. */
function drained(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    // A reader that closes the pipe mid-drain fails the queued writes with EPIPE. Without a
    // listener that 'error' crashed the process with exit 1 and a stack trace instead of the
    // settled code; the listener stays until exit because the event can follow the callback.
    stream.on('error', () => resolve());
    // Writes complete in order, so an empty write's callback runs after every earlier one.
    stream.write('', () => resolve());
  });
}

/**
 * Exit with `code` once stdout and stderr have drained.
 *
 * `process.exit` discards writes still queued on a pipe: with a slow reader a
 * headless `--json` run exited 0 with its `final` record cut mid-line and no
 * `run_summary` or `completed` after it. A reader that never reads keeps the
 * process waiting, as any blocking writer would; a SIGINT or SIGTERM during
 * that wait exits at once with `code`, so the tail may be lost but a signal
 * never overrides the result.
 *
 * The helper installs those two handlers itself, because exits before a run
 * starts (a usage error) have no run-level handlers and the default action
 * would kill the process by signal (130/143). When run-level handlers exist
 * too, whichever runs first exits with the same settled code. The temporary
 * handlers are removed if the drain completes.
 */
export async function exitAfterDrain(code: number): Promise<never> {
  settled = code;
  const onSignal = (): void => process.exit(code);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  await Promise.all([drained(stdout), drained(stderr)]);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  process.exit(code);
}
