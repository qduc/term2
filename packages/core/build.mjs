import { cp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
await rm(new URL('./dist/', import.meta.url), { recursive: true, force: true });

const child = spawn('tsc', ['-p', 'tsconfig.json'], {
  cwd: packageRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('error', (error) => {
  console.error(`[agent-core] failed to start tsc: ${error.message}`);
  process.exitCode = 1;
});
child.on('close', (code) => {
  if (code) {
    process.exitCode = code;
    return;
  }
  // Same asset copy as the root post-build (`cp -r source/prompts dist`).
  // This package emits under dist/source, and profile/role loaders resolve
  // prompts relative to that compiled tree.
  cp(new URL('../../source/prompts/', import.meta.url), new URL('./dist/source/prompts/', import.meta.url), {
    recursive: true,
  }).then(
    () => {
      process.exitCode = 0;
    },
    (error) => {
      console.error(`[agent-core] failed to copy prompts: ${error.message}`);
      process.exitCode = 1;
    },
  );
});
