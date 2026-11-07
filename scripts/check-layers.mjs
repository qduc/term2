#!/usr/bin/env node
// Enforce the layer graph over the whole production tree (src).
// Each top-level folder of src is a layer. A layer may import itself, the
// layers listed in LAYER_DEPENDENCIES, shared/ (pure helpers), and config/ (pure schemas).
// Edges that predate the guard are listed one per line in layer-allowlist.json;
// a new crossing edge fails, and a listed edge that no longer exists is reported.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exceptionKeys, failureMap, reportAndExit } from './gates/rules.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scripts, '..');
const rewriteSrc = path.join(repo, 'src');
const allowlistPath = path.join(scripts, 'layer-allowlist.json');

const LAYER_DEPENDENCIES = {
  shared: [],
  config: [],
  model: [],
  tools: ['model'],
  engine: ['model', 'tools'],
  session: ['engine', 'model', 'tools'],
  delegation: ['session', 'engine', 'model', 'tools'],
  protocol: ['delegation', 'session', 'engine', 'model', 'tools'],
  host: ['protocol', 'session'],
  clients: ['host', 'protocol'],
  app: ['clients', 'host', 'protocol', 'delegation', 'session', 'engine', 'tools', 'model'],
};

// Imports are collected from static ES module syntax, including re-exports and dynamic imports.
const IMPORT = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(?:ts|tsx|cts|mts|js|mjs|cjs)$/.test(entry.name)) yield full;
  }
}

function resolveImport(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const candidates = [unresolved, unresolved.replace(/\.(?:m|c)?jsx?$/, '')];
  for (const base of [...candidates]) candidates.push(...['.ts', '.tsx', '.cts', '.mts'].map((ext) => base + ext));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    for (const ext of ['.ts', '.tsx']) {
      const index = path.join(candidate, `index${ext}`);
      if (fs.existsSync(index)) return index;
    }
  }
  return null;
}

const relative = (file) => path.relative(rewriteSrc, file).split(path.sep).join('/');
const layerOf = (file) => relative(file).split('/')[0];

const { map: failures, add } = failureMap();
const direction = add('layer-direction');
let allowlist;
try {
  allowlist = exceptionKeys(JSON.parse(fs.readFileSync(allowlistPath, 'utf8')), 'edge', direction);
} catch (error) {
  console.error(`cannot read ${path.relative(repo, allowlistPath)}: ${error.message}`);
  process.exit(1);
}

const crossing = new Set();
for (const importer of files(rewriteSrc)) {
  const fromLayer = layerOf(importer);
  if (!LAYER_DEPENDENCIES[fromLayer]) direction(`${relative(importer)}: ${fromLayer}/ is not a layer`);
  const text = fs.readFileSync(importer, 'utf8');
  for (const [, specifier] of text.matchAll(IMPORT)) {
    const target = resolveImport(importer, specifier);
    if (!target) continue;
    if (!target.startsWith(rewriteSrc + path.sep)) {
      direction(`${relative(importer)} imports ${path.relative(repo, target)} outside src`);
      continue;
    }
    const toLayer = layerOf(target);
    if (
      toLayer === fromLayer ||
      toLayer === 'shared' ||
      toLayer === 'config' ||
      LAYER_DEPENDENCIES[fromLayer]?.includes(toLayer)
    )
      continue;
    const edge = `${relative(importer)} -> ${relative(target)} (${fromLayer} -> ${toLayer})`;
    crossing.add(edge);
    if (!allowlist.has(edge))
      direction(`${relative(importer)}: ${fromLayer}/ may not import ${toLayer}/ (edge: "${edge}")`);
  }
}
for (const edge of allowlist) if (!crossing.has(edge)) console.log(`stale allowlist entry: ${edge}`);

// Only session/ reads the log. app/ and clients/ ask the live session (store.metadata, session.acceptedHistory)
// so a metadata call never re-parses a log the session already holds in memory.
const LOG_READERS =
  /\b(readDirectLogLineages?|readFactLines\w*|readFacts|discoverDirectLogs|readDirectLogHeaderLine|readDirectResumeTitle|readDirectResumeUpdatedAt)\b/;
for (const file of files(rewriteSrc)) {
  const name = relative(file);
  if (!/^(app|clients)\//.test(name)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const hit = LOG_READERS.exec(text);
  if (hit)
    add('log-readers')(`${name}:${text.slice(0, hit.index).split('\n').length}: calls ${hit[1]} outside session/`);
}

reportAndExit(failures, `layer check passed (${allowlist.size} allowlisted crossing edges)`);
