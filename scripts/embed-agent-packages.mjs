// The gateway uses the vendored @qduc/agent-wire dev dependency, so ship it beside the build.
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const name of ['@qduc/agent-wire']) {
  const destination = resolve('dist/node_modules', name);
  await mkdir(destination, { recursive: true });
  await cp(dirname(fileURLToPath(import.meta.resolve(name))), destination, { recursive: true });
  await writeFile(
    resolve(destination, 'package.json'),
    JSON.stringify({ name, type: 'module', exports: './index.js' }) + '\n',
  );
}
