#!/usr/bin/env node
// Deterministic-lane runner for docs/plans/slow-test-suite.md.
//
// Runs the safe subset of the deterministic lane WITHOUT worker isolation
// (--isolate=false), which is where the suite's dominant cost lives
// (per-file module graph + worker startup across 549 files).
//
// Safe = files in .github/vitest.lane.safe.txt. Every file in that manifest
// was verified against at least two shuffled seeds before being listed.
//
// Usage:
//   pnpm test:lane            # two shuffled verification seeds
//   pnpm test:lane:seed 4242  # one explicit seed
//
// Exit code is the worst exit across seeds, so CI gates can call this directly.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestPath = path.join(root, '.github', 'vitest.lane.safe.txt');

const seeds = process.argv[2]
  ? [process.argv[2]]
  : ['20260829', '314159'];

const manifest = readFileSync(manifestPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

if (manifest.length === 0) {
  console.error('deterministic lane: manifest is empty, nothing to run');
  process.exit(1);
}

const config = path.join(root, 'vitest.lane.config.ts');
let worst = 0;

for (const seed of seeds) {
  console.log(`\n=== deterministic lane — isolate=false, seed=${seed} (${manifest.length} files) ===`);
  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'cross-env',
      'NODE_ENV=test',
      'vitest',
      'run',
      '--config',
      config,
      '--isolate=false',
      `--sequence.shuffle`,
      `--sequence.seed=${seed}`,
      ...manifest,
    ],
    { stdio: 'inherit', cwd: root },
  );
  const code = result.status ?? 1;
  if (code > worst) worst = code;
}

process.exit(worst);
