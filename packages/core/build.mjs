import { rm } from 'node:fs/promises';
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
  process.exitCode = code ?? 1;
});
