#!/usr/bin/env node
// Fail when a file under src cannot be reached from the production entry.
// The walk follows every static, type-only, re-export and dynamic import from
// src/app/cli.ts. A file kept on purpose without a production importer
// goes in reachability-allowlist.json with the reason it stays.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scripts, '..');
const rewriteSrc = path.join(repo, 'src');
const ENTRY = path.join(rewriteSrc, 'app/cli.ts');
const allowlistPath = path.join(scripts, 'reachability-allowlist.json');
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;

const relative = (file) => path.relative(repo, file).split(path.sep).join('/');

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) yield full;
  }
}

function resolve(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  const stem = base.replace(/\.(?:m|c)?jsx?$/, '');
  const candidates = [base, ...['.ts', '.tsx', '.mts', '.cts'].map((ext) => stem + ext)];
  candidates.push(...['index.ts', 'index.tsx'].map((name) => path.join(base, name)));
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

function imports(file) {
  const info = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true);
  return info.importedFiles.map(({ fileName }) => resolve(file, fileName)).filter(Boolean);
}

let allowlist;
try {
  allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
} catch (error) {
  console.error(`cannot read ${relative(allowlistPath)}: ${error.message}`);
  process.exit(1);
}

const reached = new Set();
const queue = [ENTRY];
while (queue.length) {
  const file = queue.pop();
  if (reached.has(file)) continue;
  reached.add(file);
  for (const target of imports(file)) if (target.startsWith(rewriteSrc + path.sep)) queue.push(target);
}

const problems = [];
const all = [...files(rewriteSrc)].map(relative).sort();
const reachedRelative = new Set([...reached].map(relative));
for (const file of all) {
  if (reachedRelative.has(file)) {
    if (allowlist[file]) problems.push(`${file} is reached from cli.ts; remove its reachability allowlist entry.`);
    continue;
  }
  const reason = allowlist[file];
  if (typeof reason !== 'string' || !reason.trim()) problems.push(`unreached from src/app/cli.ts: ${file}`);
}
for (const file of Object.keys(allowlist))
  if (!all.includes(file)) problems.push(`reachability allowlist names missing file ${file}.`);

console.log(`reachability: ${reachedRelative.size} of ${all.length} src files reached from app/cli.ts`);
if (problems.length) {
  console.error(problems.join('\n'));
  console.error(
    'Delete code production no longer reaches. If a file must stay, add it to ' +
      'scripts/reachability-allowlist.json with the reason.',
  );
  process.exit(1);
}
