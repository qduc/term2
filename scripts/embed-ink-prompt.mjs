import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Ship the installed pnpm-patched implementation, not an independently vendored
// copy: consumers do not inherit this checkout's patchedDependencies settings.
const source = resolve(dirname(fileURLToPath(import.meta.resolve('ink-prompt'))), '..');
const destination = resolve('dist/node_modules/ink-prompt');
await mkdir(destination, { recursive: true });
for (const entry of ['dist', 'package.json', 'LICENSE']) {
  await cp(resolve(source, entry), resolve(destination, entry), { recursive: true });
}
