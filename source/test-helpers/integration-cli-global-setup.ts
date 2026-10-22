import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { prepareCliCompileCache } from './cli-compile-cache.js';

export default function setup(project: TestProject): (() => void) | undefined {
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
  const require = createRequire(import.meta.url);
  const typescriptDir = path.resolve(path.dirname(require.resolve('typescript-7')), '..');
  const buildDir = path.join(projectRoot, 'node_modules', '.cache', 'term2-integration-cli');
  fs.mkdirSync(buildDir, { recursive: true });
  // Build once before workers start. Every process still gets its own home,
  // settings, provider fixture and persisted state; only emitted code is shared.
  execFileSync(
    process.execPath,
    [
      path.join(typescriptDir, 'bin', 'tsc'),
      '--project',
      'tsconfig.build.json',
      '--outDir',
      buildDir,
      '--incremental',
      '--tsBuildInfoFile',
      path.join(buildDir, 'tsconfig.tsbuildinfo'),
    ],
    { cwd: projectRoot, stdio: 'pipe' },
  );
  fs.cpSync(path.join(projectRoot, 'source', 'prompts'), path.join(buildDir, 'prompts'), { recursive: true });
  project.provide('integrationCliPath', path.join(buildDir, 'cli.js'));
  return prepareCliCompileCache(project, path.join(buildDir, 'cli.js'));
}
