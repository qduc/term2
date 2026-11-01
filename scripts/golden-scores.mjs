#!/usr/bin/env node
/** Score both fresh CLIs against the existing nine goldens, serially. Never record. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertFreshBuild } from './build-provenance.mjs';

const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
try {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/golden-scores.mjs [tree]');
  const check = () => {
    for (const kind of ['direct', 'old']) assertFreshBuild(root, kind);
  };
  check(); // Neither suite runs unless BOTH builds are fresh.
  const scenarios = fs
    .readdirSync(path.join(root, 'rewrite/parity/scenarios'))
    .filter((name) => name.endsWith('.json'));
  if (scenarios.length !== 9) throw new Error(`Expected nine golden scenarios, found ${scenarios.length}`);
  const scores = [];
  for (const [kind, cli] of [
    ['direct', 'rewrite/dist/rewrite/src/app/cli.js'],
    ['old', 'dist/cli.js'],
  ]) {
    const result = spawnSync(process.execPath, ['rewrite/parity/run.mjs', 'check', '--cli', cli], {
      cwd: root,
      encoding: 'utf8',
    });
    const score = result.stdout?.match(/^(\d+)\/9 scenarios match their goldens$/m);
    if (result.error || ![0, 1].includes(result.status) || !score)
      throw new Error(
        `${kind} golden runner failed (no score): ${result.error?.message ?? result.stderr ?? result.signal}`,
      );
    scores.push(Number(score[1]));
  }
  check(); // Do not publish scores if either build changed while suites ran.
  console.log(`direct: ${scores[0]}/9\nold CLI: ${scores[1]}/9`);
  process.exitCode = scores.every((score) => score === 9) ? 0 : 1;
} catch (error) {
  console.error(
    `Refusing golden scores: ${error.message}\nRebuild in ${root}: pnpm build && node rewrite/scripts/build.mjs`,
  );
  process.exitCode = 2;
}
