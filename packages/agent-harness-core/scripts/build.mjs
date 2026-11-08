import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
const compiler = fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript-7/package.json')));
const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.json'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
