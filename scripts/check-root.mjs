#!/usr/bin/env node
// Enforce that only allowlisted files may exist in the repository root.
// Stale reports, manifests, and temporary artifacts must go to .handoff/ or experiment folders.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scripts, '..');
const allowlistPath = path.join(scripts, 'root-allowlist.json');

const allowlist = new Set(JSON.parse(fs.readFileSync(allowlistPath, 'utf8')));
const rootFiles = fs
  .readdirSync(repo, { withFileTypes: true })
  .filter((e) => e.isFile() && !e.name.endsWith('.prove-bak'))
  .map((e) => e.name);

const problems = [];
for (const file of rootFiles) {
  if (!allowlist.has(file)) {
    problems.push(`root file not on allowlist: ${file} (path outside root allowlist)`);
  }
}

for (const allowed of allowlist) {
  if (!fs.existsSync(path.join(repo, allowed))) {
    console.log(`stale root allowlist entry: ${allowed}`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

console.log(`root allowlist check passed (${allowlist.size} allowlisted root files)`);
