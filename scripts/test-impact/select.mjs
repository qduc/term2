#!/usr/bin/env node
// Selects the test files a change can affect, from a recorded footprint map.
//   node scripts/test-impact/select.mjs <map-dir> [--json]
// Compares the current working tree with the tree the map was recorded at.
// Every uncertainty resolves toward running more tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { git, snapshotTree } from './tree.mjs';

const ts = createRequire(import.meta.url)('typescript');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A change to any of these can alter every test's behaviour.
const GLOBAL = [
  /^package\.json$/, /^pnpm-lock\.yaml$/, /^pnpm-workspace\.yaml$/, /^tsconfig.*\.json$/, /^vitest.*\.ts$/,
  /^\.github\/vitest/, /^source\/test-helpers\//, /^scripts\/test-impact\//, /^\.npmrc$/,
];

export function loadMap(mapDir) {
  const meta = JSON.parse(fs.readFileSync(path.join(mapDir, 'meta.json'), 'utf8'));
  const dir = path.join(mapDir, 'tests');
  const tests = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  return { meta, tests };
}

// Changed old-side line ranges per file, from `git diff -U0` between two trees.
export function diffTrees(a, b, cwd = root) {
  const raw = git(['diff-tree', '-r', '-U0', '--no-renames', '--no-color', '-p', a, b], { cwd });
  const changes = new Map(); // path -> { whole: bool, hunks: [[from,to]] }
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      cur = { whole: false, hunks: [], paths: [m[1], m[2]] };
      for (const p of new Set(cur.paths)) changes.set(p, cur);
    } else if (cur && /^(new file|deleted file) mode/.test(line)) {
      cur.whole = true;
    } else if (cur && line.startsWith('Binary files')) {
      cur.whole = true;
    } else if (cur && line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
      const start = Number(m[1]);
      const n = m[2] === undefined ? 1 : Number(m[2]);
      // n === 0 is a pure insertion after `start`: treat both neighbours as touched.
      cur.hunks.push(n === 0 ? [Math.max(1, start), start + 1] : [start, start + n - 1]);
    }
  }
  return changes;
}

const overlaps = (ranges, [from, to]) => {
  for (let i = 0; i < ranges.length; i += 2) if (ranges[i] <= to && ranges[i + 1] >= from) return true;
  return false;
};

// A changed file that does not parse breaks every importer, whatever lines its
// footprints executed, so line-level selection says nothing about it.
export function syntaxErrors(changes, cwd = root) {
  const bad = [];
  for (const p of changes.keys()) {
    if (!/\.(ts|tsx)$/.test(p)) continue;
    const abs = path.join(cwd, p);
    if (!fs.existsSync(abs)) continue;
    const out = ts.transpileModule(fs.readFileSync(abs, 'utf8'), {
      fileName: p,
      reportDiagnostics: true,
      compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
    });
    if (out.diagnostics?.length) bad.push(p);
  }
  return bad;
}

export function select({ meta, tests }, changes, allTests) {
  const changed = [...changes.keys()];
  if (changed.some((p) => GLOBAL.some((g) => g.test(p)))) return { all: true, reason: 'global input changed', tests: allTests };
  const broken = syntaxErrors(changes);
  if (broken.length) return { all: true, reason: `does not parse: ${broken.join(', ')}`, tests: allTests };
  const picked = new Map();
  const why = (t, r) => picked.has(t) || picked.set(t, r);
  const known = new Set(tests.map((t) => t.test));
  for (const t of allTests) if (!known.has(t)) why(t, 'no recorded footprint');
  const codeChanged = changed.some((p) => /^(source|scripts)\/.*\.(ts|tsx|mjs|js)$/.test(p));
  const partial = new Map(); // test file -> Set of test-case names (order-independent files only)
  for (const fp of tests) {
    if (fp.spawnsNode && codeChanged) why(fp.test, 'spawns a node process; code changed');
    for (const [p, ch] of changes) {
      if (p === fp.test) why(fp.test, 'test file changed');
      const exec = fp.files[p];
      if (exec) {
        if (ch.whole) why(fp.test, `executed ${p} (added/removed)`);
        else if (fp.cases && fp.shared) {
          // Import-time and hook code runs for every case; only a change there
          // selects the whole file. A change inside code that only some cases
          // ran selects just those cases.
          const sh = fp.shared[p];
          if (sh && ch.hunks.some((h) => overlaps(sh, h))) why(fp.test, `import-time/shared lines of ${p}`);
          else {
            for (const [name, files] of Object.entries(fp.cases)) {
              const r = files[p];
              if (!name) why(fp.test, 'unnamed case');
              else if (r && ch.hunks.some((h) => overlaps(r, h))) (partial.get(fp.test) ?? partial.set(fp.test, new Set()).get(fp.test)).add(name);
            }
          }
        } else if (ch.hunks.some((h) => overlaps(exec, h))) why(fp.test, `executed lines of ${p}`);
      }
      if (fp.reads.includes(p)) why(fp.test, `read ${p}`);
      const sd = fp.spawnDeps;
      if (sd && (sd.files.includes(p) || sd.dirs.some((d) => p === d || p.startsWith(d + '/')))) why(fp.test, `spawned script depends on ${p}`);
      if (fp.dirs.some((d) => p === d || p.startsWith(d + '/'))) if (ch.whole) why(fp.test, `listing of ${path.dirname(p)}`);
    }
  }
  for (const f of picked.keys()) partial.delete(f); // already running whole
  return { all: false, tests: [...picked.keys(), ...partial.keys()].sort(), whole: [...picked.keys()].sort(), partial, reasons: picked };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mapDir = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(root, 'node_modules/.cache/test-impact'));
  const map = loadMap(mapDir);
  const now = snapshotTree(root);
  const allTests = git(['ls-files', 'source', 'scripts', 'docs'], { cwd: root }).split('\n')
    .concat(git(['ls-files', '--others', '--exclude-standard', 'source', 'scripts', 'docs'], { cwd: root }).split('\n'))
    .filter((f) => /\.(test|spec)\.(ts|tsx)$/.test(f) && !/\.(e2e|integration)\./.test(f) && !f.startsWith('scripts/provider-black-box/'));
  const changes = diffTrees(map.meta.tree, now);
  const res = select(map, changes, allTests);
  const list = res.all ? allTests : res.tests;
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ changed: [...changes.keys()], all: res.all, whole: res.all ? allTests : res.whole, partial: res.all ? {} : Object.fromEntries([...res.partial].map(([f, n]) => [f, [...n]])) }));
  }
  else {
    const cases = res.all ? 0 : [...res.partial.values()].reduce((a, n) => a + n.size, 0);
    console.error(`changed files: ${changes.size}; selected ${list.length}/${allTests.length} test files${res.all ? ` (all: ${res.reason})` : ''}`);
    console.log(list.join('\n'));
  }
}
