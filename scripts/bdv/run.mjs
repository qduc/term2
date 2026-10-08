#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const claimFile = path.join(root, 'docs/experiments/bdv-pilot/claims.json');
const evidenceFile = path.join(root, 'docs/experiments/bdv-pilot/evidence.jsonl');
const probeArgs = {
  'approval-reuse-integration': [
    'exec',
    'vitest',
    'run',
    '--reporter=minimal',
    '--config',
    'vitest.integration.config.ts',
    'source/cli.integration.test.ts',
    '-t',
    'an approved shell call does not approve a later call',
  ],
};

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseCount(output, label) {
  const match = output.match(new RegExp(`${label}\\s+(\\d+) passed`));
  return match ? Number(match[1]) : null;
}

const claimId = process.argv[2];
const claims = JSON.parse(await readFile(claimFile, 'utf8')).claims;
const claim = claims.find((item) => item.id === claimId);
if (!claim || !probeArgs[claim.probe]) {
  console.error(`Usage: pnpm bdv <claim-id>\nAvailable claims: ${claims.map((item) => item.id).join(', ')}`);
  process.exit(2);
}

const startedAt = new Date();
const started = performance.now();
const result = spawnSync('pnpm', probeArgs[claim.probe], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, CI: '1', FORCE_COLOR: '0', NODE_ENV: 'test' },
  maxBuffer: 16 * 1024 * 1024,
});
const durationMs = Math.round(performance.now() - started);
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  .replace(/\u001b\[[0-9;]*m/g, '')
  .replaceAll(root, '<repo>');
const passedFiles = parseCount(output, 'Test Files');
const passedTests = parseCount(output, 'Tests');
const accepted =
  result.status === 0 && passedFiles === claim.acceptance.passedFiles && passedTests === claim.acceptance.passedTests;

const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const probePath = path.join(root, 'source/cli.integration.test.ts');
const runnerPath = fileURLToPath(import.meta.url);
const evidence = {
  schemaVersion: 1,
  claimId,
  claimDigest: digest(await readFile(claimFile)),
  probeDigest: digest(await readFile(probePath)),
  runnerDigest: digest(await readFile(runnerPath)),
  commit: git.status === 0 ? git.stdout.trim() : null,
  startedAt: startedAt.toISOString(),
  durationMs,
  command: ['pnpm', ...probeArgs[claim.probe]],
  exitCode: result.status ?? 1,
  passedFiles,
  passedTests,
  verdict: accepted ? 'pass' : 'fail',
  outputDigest: digest(output),
  output,
};

await mkdir(path.dirname(evidenceFile), { recursive: true });
await appendFile(evidenceFile, `${JSON.stringify(evidence)}\n`);
process.stdout.write(output);
console.log(`BDV ${claimId}: ${evidence.verdict}; evidence appended to docs/experiments/bdv-pilot/evidence.jsonl`);
process.exitCode = accepted ? 0 : 1;
