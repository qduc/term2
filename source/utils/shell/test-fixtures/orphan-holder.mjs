// Exits immediately but leaves a detached descendant that inherited stdout and
// started its own session. That descendant holds the pipe open, so the child's
// 'close' event never fires even though the command itself finished.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOLD_MS = 60_000;

if (process.argv[2] === 'holder') {
  setTimeout(() => process.exit(0), HOLD_MS);
} else {
  const holder = spawn(process.execPath, [fileURLToPath(import.meta.url), 'holder'], {
    detached: true,
    stdio: 'inherit',
  });
  holder.unref();
  process.stdout.write(`holder:${holder.pid}\n`);
  process.exit(0);
}
