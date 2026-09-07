import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { normalizeTestArgs } from './run-test.mjs';

const runner = resolve('scripts/run-test.mjs');

function runRunner(...args: string[]) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
}

it('removes a pnpm argument separator without widening the Vitest selection', () => {
  expect(normalizeTestArgs(['--', 'scripts/package-scripts.test.ts'])).toEqual(['scripts/package-scripts.test.ts']);
});

it('preserves a normal selector', () => {
  expect(normalizeTestArgs(['scripts/package-scripts.test.ts'])).toEqual(['scripts/package-scripts.test.ts']);
});

it('leaves no arguments alone so the package test command keeps its full-suite default', () => {
  expect(normalizeTestArgs([])).toEqual([]);
});

it('preserves flags and every argument after the separator', () => {
  expect(normalizeTestArgs(['--', '--list', '--passWithNoTests=false', 'scripts/package-scripts.test.ts'])).toEqual([
    '--list',
    '--passWithNoTests=false',
    'scripts/package-scripts.test.ts',
  ]);
});

it('forwards a pnpm-style selector to Vitest as one focused process invocation', () => {
  const result = runRunner('--', '--reporter=verbose', 'scripts/package-scripts.test.ts');

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('scripts/package-scripts.test.ts');
  expect(result.stdout).not.toContain('scripts/build-output.test.ts');
});

it('propagates Vitest failure status for a selector with no matching tests', () => {
  const result = runRunner('--', '--passWithNoTests=false', 'scripts/does-not-exist.test.ts');

  expect(result.status).toBe(1);
});
