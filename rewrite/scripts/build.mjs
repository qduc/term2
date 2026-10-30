#!/usr/bin/env node
// Build rewrite/ with its adopted source/ dependencies and copy runtime assets.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const result = spawnSync('pnpm', ['exec', 'tsc', '-p', 'rewrite/tsconfig.build.json'], {
  cwd: repo,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const emittedSource = path.join(repo, 'rewrite/dist/source');
fs.mkdirSync(path.join(emittedSource, 'providers'), { recursive: true });
fs.cpSync(path.join(repo, 'source/prompts'), path.join(emittedSource, 'prompts'), { recursive: true });
fs.copyFileSync(
  path.join(repo, 'source/providers/provider-presets.json'),
  path.join(emittedSource, 'providers/provider-presets.json'),
);
