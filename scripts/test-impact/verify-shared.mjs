#!/usr/bin/env node
// Admission tool for .github/vitest.shared-modules.txt (rule in that header).
//   node scripts/test-impact/verify-shared.mjs verify <manifest> [rounds=10]
//       Run the manifest unisolated and shuffled; exit 1 on any failing file or hang.
//   node scripts/test-impact/verify-shared.mjs grow <base-manifest> <candidates> <out-dir> [budgetMinutes=100]
//       Add candidates to the base in batches of 24. A batch must survive 10
//       clean rounds with the base; a failing batch is bisected, a failing single
//       file is excluded. Writes <out-dir>/grown.txt and <out-dir>/excluded.txt.
// Rounds vary seed and worker count (3-8) so ordering and timing both move.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = path.join(root, 'scripts/test-impact/vitest.verify-shared.config.ts');
const [mode, ...args] = process.argv.slice(2);
const read = (f) => fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-shared-'));
const ROUNDS_DEFAULT = 10, BATCH = 24, WORKERS = [3, 5, 8, 4, 6, 7];
let counter = 0;

function runOnce(files) {
  const manifest = path.join(tmp, 'cur.txt'), out = path.join(tmp, 'report.json');
  fs.writeFileSync(manifest, files.join('\n') + '\n');
  fs.rmSync(out, { force: true });
  const seed = 1000 + counter * 7, workers = WORKERS[counter % WORKERS.length];
  counter++;
  const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config, `--maxWorkers=${workers}`, '--reporter=json', `--outputFile=${out}`], {
    cwd: root, stdio: 'ignore', timeout: 300000, env: { ...process.env, NODE_ENV: 'test', SHARED_MANIFEST: manifest, SEED: String(seed) },
  });
  if (r.error || !fs.existsSync(out)) return { hang: true, failed: [], seed, workers };
  const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
  return { hang: false, seed, workers, failed: rep.testResults.filter((t) => t.status === 'failed').map((t) => path.relative(root, t.name)) };
}

function clean(files, rounds) {
  for (let i = 0; i < rounds; i++) {
    const r = runOnce(files);
    if (r.hang || r.failed.length) return { ok: false, r, round: i };
  }
  return { ok: true };
}

if (mode === 'verify') {
  const files = read(args[0]), rounds = Number(args[1] ?? ROUNDS_DEFAULT);
  const res = clean(files, rounds);
  console.log(res.ok ? `${files.length} files clean for ${rounds} rounds` : `FAILED round ${res.round} (seed ${res.r.seed}, ${res.r.workers} workers): ${res.r.hang ? 'hang or no report' : res.r.failed.join(', ')}`);
  process.exit(res.ok ? 0 : 1);
} else if (mode === 'grow') {
  const base = read(args[0]), outDir = args[2], budget = Number(args[3] ?? 100);
  const pool = read(args[1]).filter((f) => !base.includes(f));
  const t0 = Date.now(), accepted = [], excluded = [];
  const log = (m) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)}m] ${m}`);
  const grow = (batch) => {
    if (!batch.length || (Date.now() - t0) / 60000 > budget) return;
    const res = clean([...base, ...accepted, ...batch], ROUNDS_DEFAULT);
    if (res.ok) { accepted.push(...batch); return log(`ACCEPT ${batch.length} (total ${accepted.length})`); }
    const why = res.r.hang ? 'hang' : res.r.failed.slice(0, 3).join(',');
    if (batch.length === 1) { excluded.push(batch[0]); return log(`EXCLUDE ${batch[0]} (round ${res.round}: ${why})`); }
    log(`batch of ${batch.length} failed round ${res.round} (${why}); bisecting`);
    const h = batch.length >> 1;
    grow(batch.slice(0, h)); grow(batch.slice(h));
  };
  log(`base ${base.length}, pool ${pool.length}`);
  const b0 = clean(base, ROUNDS_DEFAULT);
  if (!b0.ok) { log(`BASE UNSTABLE: ${JSON.stringify(b0.r)}`); process.exit(1); }
  for (let i = 0; i < pool.length; i += BATCH) grow(pool.slice(i, i + BATCH));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'grown.txt'), [...base, ...accepted].sort().join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'excluded.txt'), excluded.join('\n') + '\n');
  log(`DONE accepted ${accepted.length}, excluded ${excluded.length}, final ${base.length + accepted.length}, rounds ${counter}`);
} else {
  console.error('usage: verify-shared.mjs verify <manifest> [rounds] | grow <base> <candidates> <out-dir> [minutes]');
  process.exit(2);
}
