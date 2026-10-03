import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const destination = resolve('dist/node_modules/@qduc/agent-wire');
await mkdir(destination, { recursive: true });
await cp(dirname(fileURLToPath(import.meta.resolve('@qduc/agent-wire'))), destination, { recursive: true });
await writeFile(
  resolve(destination, 'package.json'),
  JSON.stringify({ name: '@qduc/agent-wire', type: 'module', exports: './index.js' }) + '\n',
);
