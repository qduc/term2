import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const destination = resolve('dist/node_modules/@qduc/agent-wire');
await mkdir(destination, { recursive: true });
await cp(resolve('packages/wire/dist'), destination, { recursive: true });
await writeFile(
  resolve(destination, 'package.json'),
  JSON.stringify({ name: '@qduc/agent-wire', type: 'module', exports: './index.js' }) + '\n',
);
