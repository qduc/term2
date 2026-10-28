import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { createTestChildEnv } from './terminal-e2e.js';

/** V8 bytecode only: never reuse a process, module instance or application state. */
export function prepareCliCompileCache(project: TestProject, cliPath: string): (() => void) | undefined {
  // Node documents less precise V8 coverage for functions deserialized from a
  // compile cache. Keep instrumented runs and an explicit opt-out uncached.
  if (
    Number(process.versions.node.split('.')[0]) < 22 ||
    process.env.NODE_V8_COVERAGE ||
    process.env.NODE_DISABLE_COMPILE_CACHE === '1'
  )
    return;
  const root = mkdtempSync(join(tmpdir(), 'term2-cli-compile-cache-'));
  const cache = join(root, 'bytecode');
  try {
    // Prime before workers compete for CPU or start short fixture deadlines.
    // --help exits without a provider; any startup failure fails the suite.
    execFileSync(process.execPath, [cliPath, '--help'], {
      env: createTestChildEnv({ HOME: root, USERPROFILE: root, NODE_COMPILE_CACHE: cache }),
      cwd: root,
      stdio: 'pipe',
      timeout: 40_000,
    });
    project.provide('testNodeCompileCache', cache);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return () => rmSync(root, { recursive: true, force: true });
}
