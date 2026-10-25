import process from 'node:process';
import console from 'node:console';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const evidence = process.env.OCCURRENCE_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tool-occurrence-'));
fs.mkdirSync(evidence, { recursive: true });
const loader = [
  path.join(root, 'node_modules/tsx/dist/loader.mjs'),
  '/home/qduc/term2/node_modules/tsx/dist/loader.mjs',
].find(fs.existsSync);
if (!loader) throw new Error('tsx loader unavailable in candidate or known existing /home/qduc/term2/node_modules');
function inventory(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory()
      ? inventory(file)
      : /\.tsx?$/.test(file)
      ? [[path.relative(root, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')]]
      : [];
  });
}
fs.writeFileSync(
  path.join(evidence, 'identity.json'),
  JSON.stringify(
    {
      root,
      node: process.version,
      execPath: process.execPath,
      loader,
      head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
      status: spawnSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).stdout,
      sourceHashes: Object.fromEntries(inventory(path.join(root, 'source'))),
    },
    null,
    2,
  ),
);
let failed = false;
for (const [name, script, extra] of [
  ['journey', 'journey.mjs', {}],
  ['legacy-equal', 'legacy-request.mjs', { TAGGED: '0', DIFFERENT: '0' }],
  ['legacy-different', 'legacy-request.mjs', { TAGGED: '0', DIFFERENT: '1' }],
  ['tagged-equal', 'legacy-request.mjs', { TAGGED: '1', DIFFERENT: '0' }],
  ['tagged-different', 'legacy-request.mjs', { TAGGED: '1', DIFFERENT: '1' }],
]) {
  const result = spawnSync(
    process.execPath,
    ['--import', loader, '--import', path.join(here, 'register-fallback.mjs'), path.join(here, script)],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        SOURCE_ROOT: root,
        OCCURRENCE_EVIDENCE_DIR: evidence,
        ASSERT_PRESERVATION: '1',
        NODE_ENV: 'test',
        ...extra,
      },
    },
  );
  const output = (result.stdout || '') + (result.stderr || '') + (result.error ? String(result.error) : '');
  fs.writeFileSync(path.join(evidence, name + '.log'), output);
  fs.writeFileSync(path.join(evidence, name + '.exit'), String(result.status ?? 1) + '\n');
  if (name === 'journey' || result.status !== 0) process.stdout.write(output);
  console.log(`${name}: exit ${result.status ?? 1}`);
  failed ||= result.status !== 0;
}
fs.writeFileSync(path.join(evidence, 'verify.exit'), (failed ? '1' : '0') + '\n');
console.log(`Evidence: ${evidence}`);
process.exitCode = failed ? 1 : 0;
