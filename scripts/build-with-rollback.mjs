import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildWithRollback } from './build-output.mjs';

/**
 * `pnpm build` entry point. Keeps the previous `dist/` recoverable at
 * `dist.bak/`; see scripts/build-output.mjs for the behavior.
 *
 * Set SKIP_BUILD_BACKUP=1 to build without keeping the previous output (e.g. in
 * CI, where it is disposable and the extra copy is only cost).
 */

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

const run = (command, args) => () =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      cwd: projectRoot,
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      console.error(`[build] failed to start ${command}: ${error.message}`);
      resolve(1);
    });
  });

const exitCode = await buildWithRollback({
  distDir: fileURLToPath(new URL('../dist/', import.meta.url)),
  backupDir: fileURLToPath(new URL('../dist.bak/', import.meta.url)),
  backup: process.env.SKIP_BUILD_BACKUP !== '1',
  steps: [run('tsc', ['--project', 'tsconfig.build.json']), run('pnpm', ['run', 'post-build'])],
  log: (message) => console.log(message),
});

process.exit(exitCode);
