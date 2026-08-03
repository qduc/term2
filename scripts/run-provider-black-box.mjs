import { spawn } from 'node:child_process';

/**
 * `pnpm test:provider-black-box` entry point: build `dist/`, then run the
 * black-box configuration against the shipped CLI.
 *
 * Two flags exist to keep a broken build from looking like a hang. The suite
 * drives the built CLI through a PTY and waits on its output, so when the CLI
 * cannot start — a compile that succeeded but crashes at runtime, a renamed
 * prompt marker, a stale `dist/` — every PTY test burns its full timeout
 * instead of failing fast. `provider-session-resilience.blackbox.ts` alone
 * holds 34 sequential tests, so that turns a ~20s suite into a silent
 * 11-minute one.
 *
 * - `--reporter=verbose` streams a line per finished test. This is deliberate
 *   over the `default` reporter: both `default` and `minimal` print nothing
 *   until the summary when stdout is not a TTY, which is how CI and agents run
 *   this. Verbose makes the stalled scenario visible while it stalls.
 * - `--bail=1` stops after the first failure, which bounds a broken build to
 *   one timeout. Run vitest directly against the same config when you want the
 *   full failure list.
 */

const run = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.once('close', (code) => resolve(code ?? 1));
    child.once('error', () => resolve(1));
  });
const build = await run('pnpm', ['build']);
if (build !== 0) process.exit(build);
const tests = await run('pnpm', [
  'exec',
  'vitest',
  'run',
  '--config',
  'vitest.provider-black-box.config.ts',
  '--reporter=verbose',
  '--bail=1',
]);
process.exit(tests);
