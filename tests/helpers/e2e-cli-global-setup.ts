import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { prepareCliCompileCache } from './cli-compile-cache.js';

/**
 * Prime one V8 compile cache for every built-CLI launch in the e2e tier, as the integration and
 * provider tiers already do. Each launch otherwise recompiles the single-file entry bundle.
 *
 * `pnpm test:codex-network` shares this config without needing a build, so a missing CLI only
 * skips priming; the e2e files that launch it report the missing build themselves.
 */
export default function setup(project: TestProject): (() => void) | undefined {
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
  const cliPath = process.env.TERM2_TEST_CLI
    ? path.resolve(projectRoot, process.env.TERM2_TEST_CLI)
    : path.join(projectRoot, 'dist', 'cli.js');
  if (!fs.existsSync(cliPath)) return;
  return prepareCliCompileCache(project, cliPath);
}
