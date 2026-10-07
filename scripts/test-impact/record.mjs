#!/usr/bin/env node
// Records an execution-footprint map for the unit suite.
//   node scripts/test-impact/record.mjs <out-dir> [vitest args...]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotTree } from './tree.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [out = path.join(root, 'node_modules/.cache/test-impact'), ...rest] = process.argv.slice(2);
const outDir = path.resolve(out);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const tree = snapshotTree(root);
const started = Date.now();
const r = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.impact.config.ts', '--reporter=dot', ...rest],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test', TERM2_IMPACT_DIR: path.join(outDir, 'tests'), TERM2_IMPACT_ROOT: root },
  },
);
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ tree, seconds: (Date.now() - started) / 1000, vitestStatus: r.status }));
console.log(`recorded ${fs.readdirSync(path.join(outDir, 'tests')).length} footprints at tree ${tree}`);
