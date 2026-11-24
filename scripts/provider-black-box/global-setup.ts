import { testCliPath } from '../../tests/helpers/terminal-e2e.js';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { prepareCliCompileCache } from '../../tests/helpers/cli-compile-cache.js';
import { bundleProviderRecorder } from './recorder-bundle.js';

export default async function setup(project: TestProject): Promise<() => void> {
  const cleanupCache = prepareCliCompileCache(
    project,
    testCliPath(fileURLToPath(new URL('../../dist/cli.js', import.meta.url))),
  );
  const { bundlePath, cleanup: cleanupBundle } = await bundleProviderRecorder();
  project.provide('providerRecorderBundle', bundlePath);
  return () => {
    cleanupBundle();
    cleanupCache?.();
  };
}
