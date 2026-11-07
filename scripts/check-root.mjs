#!/usr/bin/env node
// Enforce that only allowlisted files may exist in the repository root.
// Stale reports, manifests, and temporary artifacts must go to .handoff/ or experiment folders.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exceptionKeys, failureMap, reportAndExit } from './gates/rules.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scripts, '..');
const allowlistPath = path.join(scripts, 'root-allowlist.json');

const { map: failures, add } = failureMap();
const problem = add('root-files');
const allowlist = exceptionKeys(JSON.parse(fs.readFileSync(allowlistPath, 'utf8')), 'file', problem);
const rootFiles = fs
  .readdirSync(repo, { withFileTypes: true })
  .filter((e) => e.isFile() && !e.name.endsWith('.prove-bak'))
  .map((e) => e.name);

for (const file of rootFiles) if (!allowlist.has(file)) problem(`root file not on allowlist: ${file}`);

for (const allowed of allowlist) {
  if (!fs.existsSync(path.join(repo, allowed))) {
    console.log(`stale root allowlist entry: ${allowed}`);
  }
}

reportAndExit(failures, `root allowlist check passed (${allowlist.size} allowlisted root files)`);
