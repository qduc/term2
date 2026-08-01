import { spawn } from 'node:child_process';
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
  '--reporter=minimal',
]);
process.exit(tests);
