// Records, per test file, which original source lines it executed and which
// non-code files it read. Opt-in: only active when TERM2_IMPACT_DIR is set (see
// vitest.impact.config.ts). The footprint is later compared against a git diff
// to decide which tests a change can affect — see docs/plans/test-impact-map.md.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import inspector from 'node:inspector';
import { SourceMap } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, expect } from 'vitest';

const outDir = process.env.TERM2_IMPACT_DIR;
const repoRoot = process.env.TERM2_IMPACT_ROOT ?? process.cwd();

// A wrapper must be indistinguishable from the original: carry over every own
// property, symbols included (execFile's util.promisify.custom, for one).
function keepProps(wrapper: Function, orig: Function) {
  for (const key of Reflect.ownKeys(orig)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    Object.defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(orig, key)!);
  }
}

if (outDir) {
  const reads = new Set<string>();
  const dirs = new Set<string>();
  const note = (p: unknown, into: Set<string>) => {
    if (typeof p !== 'string' && !(p instanceof URL)) return;
    const abs = path.resolve(p instanceof URL ? fileURLToPath(p) : p);
    if (abs.startsWith(repoRoot + path.sep) && !abs.includes(`${path.sep}node_modules${path.sep}`)) {
      into.add(path.relative(repoRoot, abs));
    }
  };
  // Any path a test touches through fs is part of its footprint, whether or
  // not it exists: a file appearing later could change the outcome.
  for (const name of [
    'readFileSync',
    'readFile',
    'openSync',
    'open',
    'statSync',
    'lstatSync',
    'existsSync',
    'accessSync',
    'createReadStream',
    'realpathSync',
    'readlinkSync',
  ]) {
    const orig = (fs as any)[name];
    if (typeof orig !== 'function') continue;
    (fs as any)[name] = function (this: unknown, p: unknown, ...rest: unknown[]) {
      note(p, reads);
      return orig.call(this, p, ...rest);
    };
    keepProps((fs as any)[name], orig);
  }
  for (const name of ['readdirSync', 'readdir', 'opendirSync', 'globSync']) {
    const orig = (fs as any)[name];
    if (typeof orig !== 'function') continue;
    (fs as any)[name] = function (this: unknown, p: unknown, ...rest: unknown[]) {
      note(p, dirs);
      return orig.call(this, p, ...rest);
    };
    keepProps((fs as any)[name], orig);
  }
  // A test that starts another node process runs repo code this recorder cannot
  // see, so its footprint cannot be trusted to name that code. Flag it; the
  // selector then runs it for any code change.
  let spawnsNode = false;
  const spawnScripts = new Set<string>();
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const orig = (childProcess as any)[name];
    if (typeof orig !== 'function') continue;
    (childProcess as any)[name] = function (this: unknown, cmd: unknown, ...rest: unknown[]) {
      const text = [cmd, ...rest.filter(Array.isArray).flat()].map(String).join(' ');
      // A spawn that names a script inside the repo runs repo code we cannot
      // see: record the script, so the selector can follow its imports and its
      // directory. `node -e ''`, rg and git run none of it. Only a spawn
      // through tsx/npx/pnpm with no nameable script stays opaque.
      const tokens = [cmd, ...rest.filter(Array.isArray).flat()].map(String);
      let named = false;
      for (const tok of tokens.flatMap((t) => t.split(/\s+/))) {
        const abs = path.resolve(tok.replace(/^['"]|['"]$/g, ''));
        if (
          /\.(?:m?[jt]sx?|cjs)$/.test(abs) &&
          abs.startsWith(repoRoot + path.sep) &&
          !abs.includes(`${path.sep}node_modules${path.sep}`) &&
          fs.existsSync(abs)
        ) {
          spawnScripts.add(path.relative(repoRoot, abs));
          named = true;
        }
      }
      if (!named && /(^|[\\/\s])(tsx|npx|pnpm)(\s|$)/.test(text)) spawnsNode = true;
      return orig.call(this, cmd, ...rest);
    };
    keepProps((childProcess as any)[name], orig);
  }
  (await import('node:module')).syncBuiltinESMExports();

  const session = new inspector.Session();
  session.connect();
  const post = (m: string, p?: object) =>
    new Promise<any>((res, rej) => session.post(m, p as any, (e, r) => (e ? rej(e) : res(r))));
  const sources = new Map<string, string>();
  session.on('Debugger.scriptParsed', (e: any) => sources.set(e.params.scriptId, e.params.url));
  await post('Debugger.enable');
  await post('Profiler.enable');
  await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

  const testPath = () => expect.getState().testPath ?? 'unknown';
  const relTest = () => path.relative(repoRoot, testPath());
  // Files proven order-independent (shuffled in several seeds) get per-test
  // footprints, so a change can select single test cases. Everything else
  // stays file-level.
  const perTestFiles = new Set(
    fs.existsSync(path.join(repoRoot, 'scripts/test-impact/order-independent.txt'))
      ? fs
          .readFileSync(path.join(repoRoot, 'scripts/test-impact/order-independent.txt'), 'utf8')
          .split('\n')
          .filter(Boolean)
      : [],
  );

  const prepared = new Map<string, Prepared | null>();
  // Executed original lines per repo file since the last take (counters reset).
  const snapshot = async (): Promise<Record<string, number[]>> => {
    const { result } = await post('Profiler.takePreciseCoverage');
    const out: Record<string, number[]> = {};
    for (const script of result as any[]) {
      if (!script.functions.some((f: any) => f.ranges.some((r: any) => r.count > 0))) continue;
      let file: string | undefined;
      try {
        const u = sources.get(script.scriptId) ?? script.url;
        file = u.startsWith('file://') ? fileURLToPath(u) : u;
      } catch {
        continue;
      }
      if (!file || !file.startsWith(repoRoot + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`))
        continue;
      let prep = prepared.get(script.scriptId);
      if (prep === undefined) {
        const { scriptSource } = await post('Debugger.getScriptSource', { scriptId: script.scriptId });
        prep = prepare(scriptSource as string);
        prepared.set(script.scriptId, prep);
      }
      const lines = executedLines(prep, script.functions);
      const rel = path.relative(repoRoot, file);
      out[rel] = out[rel] ? mergeRanges(out[rel], lines) : lines;
    }
    return out;
  };
  const mergeInto = (into: Record<string, number[]>, add: Record<string, number[]>) => {
    for (const [f, r] of Object.entries(add)) into[f] = into[f] ? mergeRanges(into[f], r) : r;
  };

  const perTest = perTestFiles.has(relTest());
  const shared: Record<string, number[]> = {}; // outside any test window: imports, beforeAll, afterAll
  const cases: Record<string, Record<string, number[]>> = {};
  if (perTest) {
    beforeEach(async () => {
      mergeInto(shared, await snapshot());
    });
    afterEach(async () => {
      const name = (expect.getState().currentTestName ?? '').replace(/ > /g, ' ');
      const win = await snapshot();
      cases[name] = cases[name] ? (mergeInto(cases[name], win), cases[name]) : win;
    });
  }

  afterAll(async () => {
    const tail = await snapshot();
    fs.mkdirSync(outDir, { recursive: true });
    const files: Record<string, number[]> = {};
    mergeInto(files, shared);
    mergeInto(files, tail);
    for (const c of Object.values(cases)) mergeInto(files, c);
    const rec: Record<string, unknown> = {
      test: relTest(),
      files,
      reads: [...reads],
      dirs: [...dirs],
      spawnsNode,
      spawnDeps: spawnDeps(spawnScripts),
    };
    if (perTest) {
      mergeInto(shared, tail);
      rec.shared = shared;
      rec.cases = cases;
    }
    const key = relTest().replace(/[\\/]/g, '__');
    fs.writeFileSync(path.join(outDir, `${key}.json`), JSON.stringify(rec));
  });
}

type Prepared = { source: string; genLineStarts: number[]; genToOrig: number[][]; total: number } | null;

function mergeRanges(a: number[], b: number[]): number[] {
  const all: Array<[number, number]> = [];
  for (let i = 0; i < a.length; i += 2) all.push([a[i], a[i + 1]]);
  for (let i = 0; i < b.length; i += 2) all.push([b[i], b[i + 1]]);
  all.sort((x, y) => x[0] - y[0]);
  const out: number[] = [];
  for (const [s, e] of all) {
    if (out.length && s <= out[out.length - 1] + 1) out[out.length - 1] = Math.max(out[out.length - 1], e);
    else out.push(s, e);
  }
  return out;
}

// Once per script: where each generated line starts and which original lines
// it maps to. null means no trustworthy map, so callers claim the whole file.
function prepare(source: string): Prepared {
  // Vitest appends further comments (vitestCache=...) after the source-map
  // comment, so take the last sourceMappingURL anywhere in the script.
  let map: SourceMap | undefined;
  const marker = '//# sourceMappingURL=data:application/json;base64,';
  const at = source.lastIndexOf(marker);
  if (at >= 0) {
    const b64 = /^[A-Za-z0-9+/=]+/.exec(source.slice(at + marker.length, at + marker.length + 4_000_000))?.[0];
    try {
      if (b64) map = new SourceMap(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')));
    } catch {
      map = undefined;
    }
  }
  if (!map) return null;
  const total = ((map.payload as any).sourcesContent?.[0] as string | undefined)?.split('\n').length ?? 0;
  if (!total) return null;
  // The module wrapper sits on generated line 0 before the transformed code.
  const wrapperEnd = source.startsWith("'use strict';async (") ? source.indexOf('=>{{') + 4 : 0;
  const genLineStarts: number[] = [];
  const genToOrig: number[][] = [];
  let lineStart = 0;
  let genLine = 0;
  while (lineStart <= source.length) {
    let lineEnd = source.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = source.length;
    genLineStarts.push(lineStart);
    const base = genLine === 0 ? wrapperEnd : 0;
    const origs = new Set<number>();
    // Sample several columns so one generated line folding several original
    // lines stays covered.
    for (let col = 0; col <= lineEnd - lineStart - base; col += 8) {
      const entry = map.findEntry(genLine, col) as any;
      if (entry && typeof entry.originalLine === 'number') origs.add(entry.originalLine + 1);
    }
    genToOrig.push([...origs]);
    lineStart = lineEnd + 1;
    genLine++;
  }
  genLineStarts.push(source.length + 1);
  return { source, genLineStarts, genToOrig, total };
}

// Returns [start,end, start,end, ...] 1-based inclusive original line ranges.
function executedLines(prep: Prepared, functions: any[]): number[] {
  // Without a usable map line numbers cannot be trusted: claim the whole file
  // so any edit to it selects this test. Over-selecting is the safe direction.
  if (!prep) return [1, 1_000_000_000];
  const { source, genLineStarts, genToOrig, total } = prep;
  const count = new Int32Array(source.length + 1).fill(-1);
  const ranges: Array<[number, number, number]> = [];
  for (const f of functions) for (const r of f.ranges) ranges.push([r.startOffset, r.endOffset, r.count]);
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  for (const [s, e, c] of ranges) count.fill(c, s, e);

  // Per original line: true if any executed generated line maps to it, false if
  // it is mapped only by never-executed generated lines. Lines nothing maps to
  // (closing braces, comments, interiors of multi-line literals) inherit from
  // the nearest mapped line above, and from below at the top of the file —
  // never "unexecuted" by default, so an edit there can only over-select.
  const status = new Map<number, boolean>();
  for (let g = 0; g < genToOrig.length; g++) {
    const lineStart = genLineStarts[g];
    const lineEnd = genLineStarts[g + 1] - 1;
    let executed = false;
    for (let i = lineStart; i < lineEnd; i++) {
      if (count[i] > 0 && source.charCodeAt(i) > 32) {
        executed = true;
        break;
      }
    }
    for (const l of genToOrig[g]) status.set(l, (status.get(l) ?? false) || executed);
  }
  const filled: boolean[] = new Array(total + 1).fill(false);
  let prev: boolean | undefined;
  for (let l = 1; l <= total; l++) {
    const st = status.get(l);
    if (st !== undefined) prev = st;
    filled[l] = st ?? prev ?? true;
  }
  const packed: number[] = [];
  for (let l = 1; l <= total; l++) {
    if (!filled[l]) continue;
    if (packed.length && packed[packed.length - 1] === l - 1) packed[packed.length - 1] = l;
    else packed.push(l, l);
  }
  return packed;
}

// Files a spawned script can run or read: its static relative-import closure
// plus everything in its own directory (fixtures sit beside their scripts).
function spawnDeps(scripts: Set<string>): { files: string[]; dirs: string[] } {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const queue = [...scripts];
  while (queue.length) {
    const rel = queue.pop()!;
    if (files.has(rel)) continue;
    files.add(rel);
    dirs.add(path.dirname(rel));
    let text = '';
    try {
      text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/(?:from|import|require)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const base = path.join(path.dirname(rel), m[1]);
      const stem = base.replace(/\.(?:js|jsx|mjs)$/, '');
      for (const c of [
        base,
        `${stem}.ts`,
        `${stem}.tsx`,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.mjs`,
        path.join(base, 'index.ts'),
      ]) {
        if (fs.existsSync(path.join(repoRoot, c))) {
          queue.push(c);
          break;
        }
      }
    }
  }
  return { files: [...files], dirs: [...dirs] };
}
