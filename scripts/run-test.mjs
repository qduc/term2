#!/usr/bin/env node
// Keep `pnpm test -- <selector>` focused even when a package-manager argument
// separator reaches the script instead of being consumed by pnpm.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function normalizeTestArgs(args) {
  return args[0] === '--' ? args.slice(1) : args;
}

function main() {
  const result = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--reporter=minimal', ...normalizeTestArgs(process.argv.slice(2))],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: 'inherit',
    },
  );

  if (result.error) {
    console.error(`test runner: unable to start Vitest: ${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
