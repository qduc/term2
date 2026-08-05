import { spawn } from 'node:child_process';
import type { Term2Hooks, Term2Status } from '@qduc/term2/hooks';

/**
 * Example only: replace the command arguments with the Herdr pane/status
 * command used by the local installation. This deliberately talks to Herdr
 * as an external consumer instead of adding Herdr code to Term2.
 */
export default function register(term2: Term2Hooks): void {
  term2.on('status.change', (event) => {
    const status: Term2Status = event.current;
    const child = spawn('herdr', ['status', status], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
  });
}
