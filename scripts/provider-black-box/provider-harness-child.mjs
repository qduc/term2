import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
const markerPath = join(process.env.TERM2_HARNESS_MARKER_DIR ?? process.cwd(), 'marker.txt');

if (mode === 'write') {
  await writeFile(markerPath, 'written by first child\n', 'utf8');
  process.stdout.write('\x1b[32mwrote marker\x1b[0m\r\n');
} else if (mode === 'read') {
  process.stdout.write(`read marker: ${(await readFile(markerPath, 'utf8')).trim()}\r\n`);
} else if (mode === 'hang') {
  process.stdout.write('hanging\r\n');
  await new Promise(() => setInterval(() => undefined, 1_000));
} else if (mode === 'spawn-tree-and-hang') {
  const pidPath = process.env.TERM2_HARNESS_TREE_PID_PATH;
  if (!pidPath) throw new Error('TERM2_HARNESS_TREE_PID_PATH is required for spawn-tree-and-hang');
  const leaf = spawn(process.execPath, [fileURLToPath(import.meta.url), 'tree-leaf'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'ignore',
  });
  await writeFile(pidPath, `${leaf.pid}\n`, 'utf8');
  process.stdout.write('tree ready\r\n');
  await new Promise(() => setInterval(() => undefined, 1_000));
} else if (mode === 'tree-leaf') {
  await new Promise(() => setInterval(() => undefined, 1_000));
} else if (mode === 'append') {
  await appendFile(markerPath, 'appended by relaunch\n', 'utf8');
  process.stdout.write('appended\r\n');
} else if (mode === 'openai-base-url') {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: 'fixture-key' });
  const response = await client.responses.create({ model: 'fixture', input: 'hello' });
  process.stdout.write(`openai response: ${response.id}\r\n`);
} else if (mode === 'echo') {
  process.stdout.write('ready\r\n');
  process.stdin.once('data', (chunk) => {
    process.stdout.write(`echo: ${String(chunk).trim()}\r\n`, () => process.exit(0));
  });
} else {
  throw new Error(`Unknown harness child mode: ${mode ?? '<missing>'}`);
}
