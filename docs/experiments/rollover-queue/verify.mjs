// Retained author evidence, not a permanent test tier. Stages temporary fixtures
// exclusively, runs the real hooks/runtime, and removes only files it created.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const fixtures = [
  ['hook-runtime.fixture.tsx.txt', 'source/hooks/rollover-queue.probe.test.tsx'],
  ['persistence.fixture.ts.txt', 'source/services/conversation/rollover-queue-persistence.probe.test.ts'],
  ['journal-repair.fixture.tsx.txt', 'source/hooks/journal-repair.probe.test.tsx'],
];
const created = [];
try {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const diff = spawnSync('git', ['diff', '--binary', '--', 'source'], { cwd: root, encoding: 'utf8' });
  if (head.status !== 0 || diff.status !== 0) throw new Error('Source identity unavailable.');
  console.log(
    'SOURCE_SNAPSHOT',
    JSON.stringify({
      head: head.stdout.trim(),
      dirty: Boolean(diff.stdout),
      sourcePatchSHA256: createHash('sha256').update(diff.stdout).digest('hex'),
      fixtures: Object.fromEntries(
        fixtures.map(([file]) => [
          file,
          createHash('sha256')
            .update(fs.readFileSync(path.join(here, file)))
            .digest('hex'),
        ]),
      ),
    }),
  );
  for (const [fixture, target] of fixtures) {
    const destination = path.join(root, target);
    fs.writeFileSync(destination, fs.readFileSync(path.join(here, fixture)), { flag: 'wx' });
    created.push(destination);
  }
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--reporter=verbose',
      ...fixtures.map(([, target]) => target),
    ],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: 'inherit',
      timeout: 90_000,
    },
  );
  if (result.error) console.error(result.error);
  console.log('FIXTURE_EXIT', result.status ?? 124);
  process.exitCode = result.status ?? 124;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const file of created) fs.unlinkSync(file);
}
