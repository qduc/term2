import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Set in each test worker and inherited by every CLI, shell and fixture process it starts. */
export const TEST_OWNER_ENV = 'TERM2_TEST_OWNER';

/**
 * SIGKILL processes this worker started that outlived their test workspace.
 *
 * The CLI runs shell calls in their own process group, so killing the CLI's group leaves a
 * background fixture command (a `while [ ! -e release ]` loop) running. Once the test removes the
 * workspace, the loop can never finish. A process counts as leaked only when it carries this
 * worker's owner marker and its working directory is a deleted directory under the temp dir, so
 * a live workspace or another runner's process is never touched. Linux only: elsewhere there is
 * no /proc and it does nothing.
 */
export function killLeakedWorkspaceProcesses(owner = process.env[TEST_OWNER_ENV]): number {
  if (process.platform !== 'linux' || !owner) return 0;
  const tmp = fs.realpathSync(os.tmpdir()) + path.sep;
  const marker = `${TEST_OWNER_ENV}=${owner}\0`;
  let killed = 0;
  // A second pass catches a child forked between reading and killing its parent.
  for (let pass = 0; pass < 3; pass += 1) {
    let found = 0;
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try {
        const cwd = fs.readlinkSync(`/proc/${entry}/cwd`);
        if (!cwd.startsWith(tmp) || !cwd.endsWith(' (deleted)')) continue;
        if (!`\0${fs.readFileSync(`/proc/${entry}/environ`, 'latin1')}\0`.includes(`\0${marker}`)) continue;
        process.kill(Number(entry), 'SIGKILL');
        found += 1;
      } catch {
        // exited meanwhile, or not ours to inspect
      }
    }
    killed += found;
    if (found === 0) break;
  }
  return killed;
}
