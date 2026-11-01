#!/usr/bin/env node
/** Score both fresh CLIs against the nine goldens, then stress background ordering. Never record. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { assertFreshBuild } from './build-provenance.mjs';

const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const clis = [
  ['direct', 'rewrite/dist/rewrite/src/app/cli.js'],
  ['old', 'dist/cli.js'],
];
const repeats = 24;
const parallel = 6;

function score(result, kind, total) {
  const matched = result.stdout?.match(new RegExp(`^(\\d+)/${total} scenarios match their goldens$`, 'm'));
  if (result.error || ![0, 1].includes(result.status) || !matched)
    throw new Error(
      `${kind} golden runner failed (no score): ${result.error?.message ?? result.stderr ?? result.signal}`,
    );
  const passed = Number(matched[1]);
  if (passed > total || (result.status === 0) !== (passed === total))
    throw new Error(`${kind} golden runner returned an inconsistent score/status`);
  if (passed !== total) console.error(`${kind}:\n${result.stdout}\n${result.stderr ?? ''}`);
  return passed;
}

function repeat(cli) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['rewrite/parity/run.mjs', 'check', '--cli', cli, 'subagent-batch'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ stdout, stderr, status, signal }));
  });
}

async function stress(kind, cli) {
  let next = 0;
  let passed = 0;
  // A failed occurrence is never retried or outvoted; collect all 24 outcomes.
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < repeats) {
        const iteration = ++next;
        const matched = score(await repeat(cli), `${kind} subagent-batch ${iteration}/${repeats}`, 1);
        passed += matched;
      }
    }),
  );
  return passed;
}

try {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/golden-scores.mjs [tree]');
  const check = () => {
    for (const [kind] of clis) assertFreshBuild(root, kind);
  };
  check(); // Neither suite runs unless BOTH builds are fresh.
  const scenarios = fs
    .readdirSync(path.join(root, 'rewrite/parity/scenarios'))
    .filter((name) => name.endsWith('.json'));
  if (scenarios.length !== 9) throw new Error(`Expected nine golden scenarios, found ${scenarios.length}`);
  const scores = [];
  for (const [kind, cli] of clis) {
    scores.push(
      score(
        spawnSync(process.execPath, ['rewrite/parity/run.mjs', 'check', '--cli', cli], {
          cwd: root,
          encoding: 'utf8',
        }),
        kind,
        9,
      ),
    );
  }
  const loaded = [];
  for (const [kind, cli] of clis) loaded.push(await stress(kind, cli));
  check(); // Do not publish scores if either build changed while suites ran.
  console.log(`direct: ${scores[0]}/9\nold CLI: ${scores[1]}/9`);
  console.log(
    `subagent-batch at ${parallel} parallel: direct ${loaded[0]}/${repeats}, old CLI ${loaded[1]}/${repeats}`,
  );
  process.exitCode = scores.every((value) => value === 9) && loaded.every((value) => value === repeats) ? 0 : 1;
} catch (error) {
  console.error(
    `Refusing golden scores: ${error.message}\nRebuild in ${root}: pnpm build && node rewrite/scripts/build.mjs`,
  );
  process.exitCode = 2;
}
