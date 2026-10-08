#!/usr/bin/env node
// Shrinks the list of files that ran before a failing file in one shared worker to the
// smallest list that still makes it fail (delta debugging), so the file that leaves the
// polluting state behind is named.
//
//   1. Capture which files each worker ran, in order:
//        TERM2_SHARED_TRACE=/tmp/trace.tsv pnpm test:shared --sequence.shuffle.files --sequence.seed=N
//      (each line: pid <TAB> timestamp <TAB> absolute test path)
//   2. Build the order for the worker that ran the failing file (its file last) and run:
//        node scripts/test-impact/ddmin-order.mjs /tmp/order.txt
//      /tmp/order.txt holds that worker's files, one repo-relative path per line, failing file last.
//
// The failing file is recognised by a `FAIL ... <its basename>` line in the Vitest output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = process.argv[2];
if (!source) {
  console.error('usage: ddmin-order.mjs <order-file>   (failing file last)');
  process.exit(2);
}
const all = fs.readFileSync(source, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const target = all[all.length - 1];
const needle = path.basename(target);
let pre = all.slice(0, -1);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-ddmin-'));
let runs = 0;

function fails(subset) {
  runs++;
  const orderFile = path.join(scratch, 'order.txt');
  fs.writeFileSync(orderFile, [...subset, target].join('\n') + '\n');
  const r = spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--config', 'scripts/test-impact/vitest.replay.config.ts', '--reporter=dot'],
    { cwd: root, env: { ...process.env, NODE_ENV: 'test', ORDER_FILE: orderFile }, encoding: 'utf8', timeout: 300_000 },
  );
  return new RegExp(`FAIL[^\\n]*${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(`${r.stdout}${r.stderr}`);
}

try {
  if (!fails(pre)) {
    console.log('does not reproduce with the full predecessor list; the failure is not a deterministic order effect');
    process.exit(1);
  }
  let n = 2;
  while (pre.length >= 2) {
    const size = Math.ceil(pre.length / n);
    const chunks = [];
    for (let i = 0; i < pre.length; i += size) chunks.push(pre.slice(i, i + size));
    let reduced = false;
    for (const chunk of chunks) {
      if (fails(chunk)) { pre = chunk; n = 2; reduced = true; break; }
    }
    if (!reduced) {
      for (const chunk of chunks) {
        const rest = pre.filter((f) => !chunk.includes(f));
        if (rest.length && fails(rest)) { pre = rest; n = Math.max(n - 1, 2); reduced = true; break; }
      }
    }
    if (!reduced) {
      if (n >= pre.length) break;
      n = Math.min(pre.length, n * 2);
    }
    console.log(`runs=${runs} remaining predecessors=${pre.length}`);
  }
  console.log('Minimal predecessor set (order preserved):');
  for (const f of pre) console.log(`  ${f}`);
  console.log(`then ${target}   (${runs} runs)`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
