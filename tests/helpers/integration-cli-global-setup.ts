import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { prepareCliCompileCache } from './cli-compile-cache.js';

export default function setup(project: TestProject): (() => void) | undefined {
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
  // run-ci-lane sets TERM2_TEST_CLI to the built entry module; otherwise use the
  // package's bin. Both need a prior `pnpm build`: there is no second CLI to compile.
  const cliPath = process.env.TERM2_TEST_CLI
    ? path.resolve(projectRoot, process.env.TERM2_TEST_CLI)
    : path.join(projectRoot, 'dist', 'cli.js');
  try {
    fs.accessSync(cliPath, fs.constants.R_OK);
  } catch {
    throw new Error(`Missing built CLI ${cliPath}; run pnpm build first`);
  }
  project.provide('integrationCliPath', cliPath);
  return prepareCliCompileCache(project, cliPath);
}
