#!/usr/bin/env node
// Runs the tests a change can affect.
//   node scripts/test-impact/run.mjs <map-dir>
// Whole files go in one Vitest invocation; order-independent files with
// per-case footprints go in a second, filtered to the selected cases. Exit
// status is the worst of the two. Vitest's -t is global, so the two sets
// cannot share one invocation.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mapDir = process.argv[2] ?? path.join(root, 'node_modules/.cache/test-impact');
const sel = spawnSync(process.execPath, [path.join(root, 'scripts/test-impact/select.mjs'), mapDir, '--json'], { cwd: root, encoding: 'utf8' });
if (sel.status !== 0) { process.stderr.write(sel.stderr); process.exit(sel.status ?? 1); }
const { whole, partial, all } = JSON.parse(sel.stdout);
const partialFiles = Object.keys(partial);
const cases = Object.values(partial).reduce((a, n) => a + n.length, 0);
console.error(`impact: ${whole.length} whole files${all ? ' (all)' : ''}, ${partialFiles.length} files / ${cases} cases`);
const vitest = (args) => spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=dot', ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' } }).status ?? 1;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let status = 0;
if (whole.length) status = Math.max(status, vitest(whole));
if (partialFiles.length) status = Math.max(status, vitest([...partialFiles, '-t', [...new Set(Object.values(partial).flat())].map(esc).join('|')]));
process.exit(status);
