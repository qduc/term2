#!/usr/bin/env node
/** Score both fresh CLIs against the nine goldens, then stress background ordering. Never record.
 * Explicit integration: node scripts/golden-scores.mjs --integrate <score-log> [tree]
 * Builds/guards run serially; the caller owns checkout isolation and runtime fencing.
 * Log paths are relative to the caller; use an existing directory outside build inputs.
 * Run without concurrent edits; head= labels HEAD, not a clean-tree certificate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { assertFreshBuild } from './build-provenance.mjs';

const integrating = process.argv[2] === '--integrate';
const root = path.resolve(process.argv[integrating ? 4 : 2] ?? fileURLToPath(new URL('..', import.meta.url)));
const clis = [
  ['direct', 'rewrite/dist/rewrite/src/app/cli.js'],
  ['old', 'dist/cli.js'],
];
const repeats = 24;
const parallel = 6;

/** Build both CLIs, invoke the unchanged strict scorer, then run static architecture guards.
 * Append one status line even on stage failure; never commit, record goldens or repair inputs.
 * Build failures skip scoring/guards. Score failures still run both guards, never masking red.
 */
function integrate(log) {
  const stages = [
    ['build-old', 'pnpm', ['build']],
    ['build-direct', process.execPath, ['rewrite/scripts/build.mjs']],
    ['score', process.execPath, [fileURLToPath(import.meta.url), root]],
    ['layers', process.execPath, ['rewrite/scripts/check-layers.mjs']],
    ['complexity', process.execPath, ['rewrite/scripts/check-complexity.mjs']],
  ];
  const statuses = Object.fromEntries(stages.map(([name]) => [name, 'not-run']));
  let head = 'unknown';
  let exitCode = 0;
  let scores = 'unavailable';
  try {
    const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (git.error || git.status !== 0) throw new Error('Cannot establish checkout HEAD');
    head = git.stdout.trim();
    for (const [name, command, args] of stages) {
      const result = spawnSync(command, args, {
        cwd: root,
        stdio: name === 'score' ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        encoding: 'utf8',
        shell: process.platform === 'win32' && command === 'pnpm',
      });
      if (name === 'score') {
        process.stdout.write(result.stdout ?? '');
        process.stderr.write(result.stderr ?? '');
        const match = result.stdout?.match(
          /^direct: (\d+\/9)\nold CLI: (\d+\/9)\nsubagent-batch at 6 parallel: direct (\d+\/24), old CLI (\d+\/24)$/m,
        );
        if (match) scores = `direct:${match[1]},old:${match[2]},loaded-direct:${match[3]},loaded-old:${match[4]}`;
      }
      statuses[name] = result.error ? 'spawn-error' : result.signal ? `signal:${result.signal}` : result.status;
      if (result.error) console.error(`${name}: ${result.error.message}`);
      if (result.error || result.status !== 0) {
        exitCode ||= result.status || 2;
        if (name.startsWith('build-')) break;
      }
    }
  } catch (error) {
    console.error(`Integration failed: ${error.message}`);
    exitCode ||= 2;
  }
  const line = `${new Date().toISOString()} ${exitCode === 0 ? 'PASS' : 'FAIL'} head=${head} ${Object.entries(statuses)
    .map(([name, status]) => `${name}=${status}`)
    .join(' ')} scores=${scores}`;
  try {
    fs.appendFileSync(path.resolve(log), `${line}\n`);
    console.log(line);
  } catch (error) {
    console.error(`Cannot append score log: ${error.message}`);
    exitCode = 2;
  }
  return exitCode;
}

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
  if (integrating) {
    if (!process.argv[3] || process.argv.length > 5)
      throw new Error('Usage: node scripts/golden-scores.mjs --integrate <score-log> [tree]');
    process.exitCode = integrate(process.argv[3]);
  } else {
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
  }
} catch (error) {
  console.error(
    `Refusing golden scores: ${error.message}\nRebuild in ${root}: pnpm build && node rewrite/scripts/build.mjs`,
  );
  process.exitCode = 2;
}
