import { testCliPath } from '../../tests/helpers/terminal-e2e.js';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { prepareCliCompileCache } from '../../tests/helpers/cli-compile-cache.js';

export default function setup(project: TestProject): (() => void) | undefined {
  return prepareCliCompileCache(project, testCliPath(fileURLToPath(new URL('../../dist/cli.js', import.meta.url))));
}
