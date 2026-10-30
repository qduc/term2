#!/usr/bin/env node
// Fails when a layer imports a layer it is not allowed to depend on.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const ALLOWED = {
  config: [],
  model: [],
  tools: ['model', 'config'],
  engine: ['model', 'tools', 'config'],
  session: ['engine', 'model', 'tools', 'config'],
  protocol: ['session', 'engine', 'model', 'tools', 'config'],
  host: ['protocol', 'session', 'config'],
  clients: ['host', 'protocol'],
  // Composition root: the only place that wires concrete layers together.
  app: ['clients', 'host', 'protocol', 'session', 'engine', 'tools', 'model', 'config'],
};

const IMPORT = /from\s+['"](\.\.?\/[^'"]+)['"]|import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.tsx?$/.test(entry.name)) yield full;
  }
}

const violations = [];
for (const file of files(src)) {
  const layer = path.relative(src, file).split(path.sep)[0];
  if (!(layer in ALLOWED)) {
    violations.push(`${path.relative(src, file)}: unknown layer "${layer}"`);
    continue;
  }
  for (const match of fs.readFileSync(file, 'utf8').matchAll(IMPORT)) {
    const target = path.relative(src, path.resolve(path.dirname(file), match[1] ?? match[2])).split(path.sep)[0];
    if (target !== layer && !ALLOWED[layer].includes(target)) {
      violations.push(`${path.relative(src, file)}: ${layer}/ may not import ${target}/`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log('layer check passed');
