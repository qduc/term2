import { stderr, stdout } from 'node:process';
import { settledExitCode } from './exit-after-drain.js';

/** The exit code for a run ended by `signal`: 130 for SIGINT, 141 for a closed pipe (SIGPIPE), else 143. */
export function exitCodeForSignal(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') return 130;
  return signal === 'SIGPIPE' ? 141 : 143;
}

/**
 * Calls `onClosed` once when stdout or stderr reports EPIPE, i.e. the reader closed the pipe while
 * the run is still writing (`term2 --json … | head -1`).
 *
 * Node ignores SIGPIPE and reports the failed write as an 'error' event on the stream, which
 * crashed the process with a stack trace and exit 1 when nothing listened. The listener stays for
 * the life of the process: a failed write can emit after the first report, and a destroyed stream
 * rejects later writes without printing anything. Once {@link exitAfterDrain} has settled the
 * code, the drain owns the EPIPE (the tail is lost, the code is kept) and `onClosed` is not
 * called. Other write errors keep their old behaviour and are rethrown.
 */
export function onStdioClosed(onClosed: () => void): void {
  let reported = false;
  const onError = (error: NodeJS.ErrnoException): void => {
    if (settledExitCode() !== undefined) return;
    if (error.code !== 'EPIPE') throw error;
    if (reported) return;
    reported = true;
    onClosed();
  };
  stdout.on('error', onError);
  stderr.on('error', onError);
}
