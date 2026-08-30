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
// Guard: a healthy seed takes ~25s on the 8-vCPU dev host. A non-isolated run
// can hang indefinitely when a leaked keepalive (timer/handle/socket) holds the
// worker pool open — observed 2026-08-29 as a 17-minute no-output hang. 180s
// gives ~7x headroom over normal while making hangs fail fast instead of
// blocking a CI/pre-push lane forever.
const SEED_TIMEOUT_MS = 180_000;
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
    { stdio: 'inherit', cwd: root, timeout: SEED_TIMEOUT_MS, killSignal: 'SIGKILL' },
  );
  const code = result.status ?? 1;
  if (result.signal === 'SIGKILL') {
    console.error(
      `deterministic lane: seed ${seed} exceeded ${SEED_TIMEOUT_MS / 1000}s — likely a leaked keepalive; treat as failure`,
    );
  }
  if (code > worst) worst = code;
}

process.exit(worst);
