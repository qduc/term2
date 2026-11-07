// Reads term2's src/ as text and, for each file that is the source of an
// allowlisted layer edge, computes which layers it could legally live in:
// a layer L such that L may import every layer the file imports, and every
// layer that imports the file may import L. Pure data analysis; runs no repo code.
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const src = path.join(root, 'src');
const DEPS = {
  shared: [],
  config: [],
  model: [],
  tools: ['model', 'config'],
  engine: ['model', 'tools', 'config'],
  session: ['engine', 'model', 'tools', 'config'],
  delegation: ['session', 'engine', 'model', 'tools', 'config'],
  protocol: ['delegation', 'session', 'engine', 'model', 'tools', 'config'],
  host: ['protocol', 'session', 'config'],
  clients: ['host', 'protocol'],
  app: ['clients', 'host', 'protocol', 'delegation', 'session', 'engine', 'tools', 'model', 'config'],
};
const LAYERS = Object.keys(DEPS);
const CONFIG_LEAF = process.env.CONFIG_LEAF === '1';
const may = (a, b) => a === b || b === 'shared' || (CONFIG_LEAF && b === 'config') || DEPS[a].includes(b);

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|cts|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(path.relative(src, p));
  }
})(src);
const fileSet = new Set(files);
const resolve = (from, spec) => {
  if (!spec.startsWith('.')) return null;
  let r = path.normalize(path.join(path.dirname(from), spec));
  const cands = [
    r,
    r.replace(/\.js$/, '.ts'),
    r.replace(/\.js$/, '.tsx'),
    r.replace(/\.cjs$/, '.cts'),
    r + '.ts',
    r + '.tsx',
    path.join(r, 'index.ts'),
  ];
  return cands.find((c) => fileSet.has(c)) ?? null;
};
const IMPORT = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const imports = new Map(),
  importers = new Map();
for (const f of files) {
  const text = fs.readFileSync(path.join(src, f), 'utf8');
  const out = new Set();
  for (const m of text.matchAll(IMPORT)) {
    const t = resolve(f, m[1]);
    if (t && t !== f) out.add(t);
  }
  imports.set(f, out);
  for (const t of out) {
    if (!importers.has(t)) importers.set(t, new Set());
    importers.get(t).add(f);
  }
}
const layer = (f) => f.split('/')[0];

const allow = JSON.parse(fs.readFileSync(path.join(root, 'scripts/layer-allowlist.json'), 'utf8'));
const edges = allow.map((s) => {
  const m = s.match(/^(\S+) -> (\S+) \((\S+) -> (\S+)\)$/);
  return { from: m[1], to: m[2], fl: m[3], tl: m[4] };
});

const legal = (f) => {
  const depL = new Set([...imports.get(f)].map(layer));
  const impL = new Set([...(importers.get(f) ?? [])].map(layer));
  return LAYERS.filter((L) => [...depL].every((d) => may(L, d)) && [...impL].every((i) => may(i, L)));
};
// Same question for the edge's TARGET: could the target move to a layer the source may import?
const legalTarget = (e) => legal(e.to).filter((L) => may(e.fl, L));

const rows = edges.map((e) => {
  const src = legal(e.from),
    tgt = legalTarget(e);
  let fix = 'design';
  if (src.length && !src.includes(e.fl)) fix = `move source -> ${src.join('|')}`;
  if (tgt.length && !tgt.includes(e.tl))
    fix = (fix === 'design' ? '' : fix + ' OR ') + `move target -> ${tgt.join('|')}`;
  return { ...e, fix };
});
// What-if: argv[4] is a JSON file of { "<path or dir/>": "<new layer>" }.
// Recount every crossing edge in src/ under that relabelling.
const violations = (over = {}) => {
  const lay = (f) => {
    let best = null;
    for (const k of Object.keys(over))
      if (
        !over[k].startsWith('CUT:') &&
        (f === k || (k.endsWith('/') && f.startsWith(k))) &&
        (!best || k.length > best.length)
      )
        best = k;
    return best ? over[best] : layer(f);
  };
  const out = [];
  // A value of "CUT:<a>|<b>" on key <file> drops that file's imports of the listed
  // targets (models deleting dead code or replacing an import with an injected port).
  const cut = new Map();
  for (const [k, v] of Object.entries(over)) if (v.startsWith('CUT:')) cut.set(k, v.slice(4).split('|'));
  for (const [f, ts] of imports)
    for (const t of ts)
      if (!(cut.get(f) ?? []).includes(t) && !may(lay(f), lay(t))) out.push(`${f} -> ${t} (${lay(f)} -> ${lay(t)})`);
  return out;
};
if (process.argv[3] === 'whatif') {
  const base = new Set(violations());
  const plan = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  let over = {};
  console.log(`baseline crossing edges: ${base.size} (allowlist has ${allow.length})`);
  for (const [name, moves] of Object.entries(plan)) {
    const before = new Set(violations(over));
    over = { ...over, ...moves };
    const after = new Set(violations(over));
    const fixed = [...before].filter((v) => !after.has(v)).length;
    const added = [...after].filter((v) => !before.has(v));
    console.log(`\n[${name}] -${fixed} +${added.length} => ${after.size}`);
    for (const a of added) console.log('   NEW ' + a);
  }
  const left = violations(over);
  console.log(`\nremaining ${left.length}:`);
  for (const v of left) console.log('   ' + v);
  process.exit(0);
}
const mode = process.argv[3] ?? 'summary';
if (mode === 'rows') for (const r of rows) console.log(`${r.fl}->${r.tl}\t${r.from} -> ${r.to}\t${r.fix}`);
else {
  const mech = rows.filter((r) => r.fix !== 'design').length;
  console.log(`edges ${rows.length}  mechanically-movable ${mech}  needs-design ${rows.length - mech}`);
}
