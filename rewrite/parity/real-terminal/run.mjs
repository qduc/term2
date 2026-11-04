#!/usr/bin/env node
// Real-terminal side-by-side check of legacy term2 and term2-next (issue #140, flip gate item 5).
//
//   node rewrite/parity/real-terminal/run.mjs --out <dir> [--store <dir>] [options]
//
//   --store <dir>     a generated store (generate-store.mjs) or a term2 data dir: legacy reads <dir>/conversations,
//                     term2-next reads <dir>/conversations-next. Each run works on a private copy. Omitted: a
//                     store is generated into <out>/store (--store-mb, default 420 per format).
//   --workspace <dir> the CLIs' cwd (default: <store>/workspace when present, else a scratch project)
//   --sizes 100x34,80x24
//   --quick           a quarter of the samples (a smoke run; not gate evidence)
//   --only latency|walk
//   --soak <file>     JSON array of soak differences to include in the report
//
// Not a CI test: a full run takes about an hour. Uses the loopback fake provider only.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    store: { type: 'string' },
    workspace: { type: 'string' },
    sizes: { type: 'string', default: '100x34,80x24' },
    quick: { type: 'boolean', default: false },
    only: { type: 'string' },
    soak: { type: 'string' },
    'store-mb': { type: 'string', default: '420' },
    'skip-build': { type: 'boolean', default: false },
  },
});
if (!values.out) {
  console.error('usage: node rewrite/parity/real-terminal/run.mjs --out <dir> [--store <dir>] [--quick]');
  process.exit(2);
}
const out = path.resolve(values.out);
fs.mkdirSync(out, { recursive: true });
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

// ---------- prerequisites on a fresh checkout: dependencies and both builds ----------
if (!fs.existsSync(path.join(repo, 'node_modules', '@xterm', 'xterm'))) {
  log('installing dependencies (pnpm install --frozen-lockfile)');
  execSync('pnpm install --frozen-lockfile', { cwd: repo, stdio: 'inherit' });
}
const { CLIS } = await import('./lib/env.mjs');
if (!values['skip-build']) {
  if (!fs.existsSync(CLIS.legacy.cli)) {
    log('building legacy CLI (pnpm build)');
    execSync('pnpm build', { cwd: repo, stdio: 'inherit' });
  }
  if (!fs.existsSync(CLIS.next.cli)) {
    log('building term2-next (node rewrite/scripts/build.mjs)');
    execFileSync(process.execPath, ['rewrite/scripts/build.mjs'], { cwd: repo, stdio: 'inherit' });
  }
}

const { startStage, calibrate, TRANSPORT, xtermVersion } = await import('./lib/terminal.mjs');
const { startCli, resolveStore } = await import('./lib/session.mjs');
const { runLatency, measureStoreTimings, summarize, gate, CLASSES, PAINT_TIMEOUT_MS } = await import('./lib/latency.mjs');
const { runWalk, MASKS } = await import('./lib/walk.mjs');
const { diffImages, textDiff, writeReport } = await import('./lib/report.mjs');

// ---------- the store ----------
let storeDir = values.store ? path.resolve(values.store) : null;
if (!storeDir) {
  storeDir = path.join(out, 'store');
  if (!fs.existsSync(path.join(storeDir, 'manifest.json'))) {
    fs.rmSync(storeDir, { recursive: true, force: true });
    log(`generating a synthetic store (${values['store-mb']} MB per format) into ${storeDir}`);
    execFileSync(process.execPath, [path.join(here, 'generate-store.mjs'), '--out', storeDir, '--size-mb', values['store-mb']], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  }
}
const store = resolveStore(storeDir);
const workspace = values.workspace ? path.resolve(values.workspace) : store.workspace;
const storeBytes = (dir) => {
  if (!dir) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size;
  }
  return total;
};

// ---------- samples ----------
const FULL = {
  'type char': 48,
  backspace: 48,
  'enter (composer)': 10,
  'arrow (model menu)': 20,
  'arrow (resume menu)': 20,
  'ctrl+o': 10,
  'shift+tab': 10,
  'open /model': 8,
  'open /settings': 8,
  'scroll (resume page down/up)': 10,
};
const samples = Object.fromEntries(
  Object.entries(FULL).map(([k, v]) => [k, values.quick ? Math.max(2, Math.ceil(v / 4)) : v]),
);
const sizes = values.sizes.split(',').map((s) => s.split('x').map(Number));

// ---------- environment and load ----------
const loads = [];
const loadTimer = setInterval(() => loads.push(os.loadavg()[0]), 5_000);
const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};
const stage = await startStage();
const environment = {
  command: `node ${path.relative(repo, path.join(here, 'run.mjs'))} ${process.argv.slice(2).join(' ')}`,
  revision: `${git(['rev-parse', 'HEAD'])}${git(['status', '--porcelain', '--', 'source', 'rewrite/src']) ? ' (dirty source tree)' : ''}`,
  terminal: TRANSPORT,
  xterm: `@xterm/xterm ${xtermVersion()}`,
  chromium: stage.chromiumVersion,
  node: process.version,
  os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: `${os.cpus()[0]?.model ?? 'unknown'} × ${os.cpus().length}`,
  memory: `${Math.round(os.totalmem() / 2 ** 30)} GiB`,
  store: storeDir,
  storeBytes: { legacy: storeBytes(store.legacy), next: storeBytes(store.next) },
  storeManifest: fs.existsSync(path.join(storeDir, 'manifest.json'))
    ? JSON.parse(fs.readFileSync(path.join(storeDir, 'manifest.json'), 'utf8')).formats
    : 'not a generated store',
  workspace: workspace ?? 'per-run scratch project',
  samples: values.quick ? 'quick (quarter samples; smoke only)' : 'full',
};
const floor = await calibrate(stage);
environment.harnessFloor = `raw pty echo (cat) key-to-paint p50 ${floor.p50.toFixed(1)} ms, max ${floor.max.toFixed(1)} ms (n=${floor.n})`;
log(`chromium ${stage.chromiumVersion}; ${environment.cpu}; ${environment.harnessFloor}`);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-rt-'));
const results = { generatedAt: new Date().toISOString(), environment, sizes: [] };

/** Workspace entries the CLIs add (the approval step creates a file); removed after each CLI. */
function workspaceGuard(dir) {
  if (!dir) return () => {};
  const before = new Set(fs.readdirSync(dir));
  return () => {
    for (const name of fs.readdirSync(dir)) if (!before.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  };
}

try {
  for (const [cols, rows] of sizes) {
    const sizeResult = { cols, rows, store: {}, latency: {}, misses: { idle: [], streaming: [] }, shots: [] };
    const raw = { idle: {}, streaming: {} };
    const walks = {};
    const resizeTo = cols === 100 ? [80, 24] : [100, 34];
    const shotDir = path.join(out, 'shots', `${cols}x${rows}`);
    for (const which of ['legacy', 'next']) {
      const restore = workspaceGuard(workspace);
      log(`${which} ${cols}x${rows}: copying store and starting`);
      const started = Date.now();
      let first = await startCli(stage, { which, scratch, cols, rows, store: store[which], workspace, keep: true });
      // Replace a CLI that stopped answering with a fresh one on the same home (and store copy), so a paint that
      // arrives after its 5 s timeout cannot land in a later measurement.
      const restart = async (stale) => {
        await stale.close();
        first = await startCli(stage, { which, scratch, cols, rows, workspace, keep: true, home: stale.home });
        await first.ready(60_000);
        return first;
      };
      try {
        // Startup is not gated (the issue gates keys); the minute is only how long a CLI may take to exist.
        await first.ready(60_000);
        const startupMs = Date.now() - started;
        if (values.only !== 'walk') {
          log(`${which}: store timings`);
          const { needsRestart, ...timings } = await measureStoreTimings(first);
          sizeResult.store[which] = { startupMs, ...timings };
          log(`${which}: ${JSON.stringify(sizeResult.store[which])}`);
          if (needsRestart) {
            log(`${which}: restarting after the failed /resume`);
            await restart(first);
          }
          for (const phase of ['idle', 'streaming']) {
            log(`${which}: latency ${phase}`);
            const misses = [];
            raw[phase][which] = await runLatency(first, { phase, samples, log, misses, restart }).catch((error) => {
              log(`${which}: latency ${phase} aborted: ${error.message.split('\n')[0]}`);
              sizeResult.errors = [...(sizeResult.errors ?? []), `${which} ${phase}: ${error.message}`];
              return Object.fromEntries(CLASSES.map((c) => [c, []]));
            });
            sizeResult.misses[phase].push(...misses.map((m) => ({ ...m, cli: which })));
            // Let a running stream finish or be cancelled before the next phase.
            first.term.write('\x1b');
            await new Promise((resolve) => setTimeout(resolve, 300));
            first.term.write('\x1b');
            await first.term.waitFor(/❯/, PAINT_TIMEOUT_MS).catch(() => {});
            await first.term.quiet(500, 40_000);
          }
        } else {
          sizeResult.store[which] = { startupMs };
        }
      } finally {
        await first.close();
      }
      if (values.only !== 'latency') {
        log(`${which}: screenshot walk`);
        let second = await startCli(stage, { which, scratch, cols, rows, workspace, home: first.home, keep: true });
        const restartWalk = async (stale) => {
          await stale.close();
          second = await startCli(stage, { which, scratch, cols: stale.term.cols, rows: stale.term.rows, workspace, home: stale.home, keep: true });
          await second.ready(60_000);
          return second;
        };
        try {
          await second.ready(60_000);
          walks[which] = await runWalk(second, { outDir: shotDir, label: which, originalSize: [cols, rows], resizeTo, log, restart: restartWalk }).catch(
            (error) => {
              log(`${which}: walk aborted: ${error.message.split('\n')[0]}`);
              sizeResult.errors = [...(sizeResult.errors ?? []), `${which} walk: ${error.message}`];
              return [];
            },
          );
        } finally {
          await second.close();
          fs.rmSync(second.home.root, { recursive: true, force: true, maxRetries: 5 });
        }
      } else {
        fs.rmSync(first.home.root, { recursive: true, force: true });
      }
      restore();
    }

    if (values.only !== 'walk') {
      for (const phase of ['idle', 'streaming']) {
        const legacy = Object.fromEntries(CLASSES.map((c) => [c, summarize(raw[phase].legacy[c])]));
        const next = Object.fromEntries(CLASSES.map((c) => [c, summarize(raw[phase].next[c])]));
        const verdicts = Object.fromEntries(CLASSES.map((c) => [c, gate(legacy[c], next[c])]));
        sizeResult.latency[phase] = { legacy, next, gate: verdicts, raw: raw[phase] };
      }
    }
    if (values.only !== 'latency') {
      for (let i = 0; i < Math.min(walks.legacy?.length ?? 0, walks.next?.length ?? 0); i++) {
        const l = walks.legacy[i];
        const n = walks.next[i];
        const diffFile = path.join(shotDir, `diff-${l.step}.png`);
        const diff = await diffImages(stage, l.file, n.file, diffFile);
        sizeResult.shots.push({
          step: l.step,
          legacy: l.file,
          next: n.file,
          diffFile,
          diff,
          identical: diff.count === 0,
          rows: textDiff(l.text, n.text, MASKS),
          notes: [...l.note.map((x) => `legacy: ${x}`), ...n.note.map((x) => `next: ${x}`)],
          text: { legacy: l.text, next: n.text },
        });
      }
    }
    results.sizes.push(sizeResult);
  }
} finally {
  clearInterval(loadTimer);
  await stage.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}

const loadStats = loads.length
  ? { min: Math.min(...loads), mean: loads.reduce((a, b) => a + b, 0) / loads.length, max: Math.max(...loads) }
  : null;
environment.loadAverage1m = loadStats
  ? `min ${loadStats.min.toFixed(2)} · mean ${loadStats.mean.toFixed(2)} · max ${loadStats.max.toFixed(2)}${loadStats.max > 9 ? ' — ABOVE 9: rerun the measurements' : ''}`
  : 'not sampled';

const allGates = results.sizes.flatMap((s) => Object.values(s.latency).flatMap((p) => Object.values(p.gate ?? {})));
const allShots = results.sizes.flatMap((s) => s.shots);
const soak = values.soak && fs.existsSync(values.soak) ? JSON.parse(fs.readFileSync(values.soak, 'utf8')) : [];
results.soak = soak;
results.verdict = {
  latency: allGates.length > 0 && allGates.every((g) => g.pass),
  screenshots: allShots.length > 0 && allShots.every((s) => s.identical),
  identicalShots: allShots.filter((s) => s.identical).length,
  totalShots: allShots.length,
  soak: soak.length ? `${soak.length} difference(s), all unexplained — fails the gate unless accepted` : 'not included in this run',
};

fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
writeReport(path.join(out, 'report.html'), results);
log(`load average (1m): ${environment.loadAverage1m}`);
log(`latency gate: ${results.verdict.latency ? 'pass' : 'FAIL'}; screenshots identical: ${results.verdict.identicalShots}/${results.verdict.totalShots}`);
log(`report: ${path.join(out, 'report.html')}`);
