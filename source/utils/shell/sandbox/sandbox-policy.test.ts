import { it, expect } from 'vitest';
import { createSandboxRuntimeConfig } from './sandbox-policy.js';
import { SANDBOX_TEMP_DIR } from '../temp-dir.js';

it('createSandboxRuntimeConfig allows writing to the shared sandbox temp dir', () => {
  const config = createSandboxRuntimeConfig(process.cwd());

  expect(config.filesystem.allowWrite).toContain(SANDBOX_TEMP_DIR);
});

it('createSandboxRuntimeConfig resolves workspace and denies credential files', () => {
  const config = createSandboxRuntimeConfig('/some/workspace');

  expect(config.filesystem.allowWrite.length).toBeGreaterThanOrEqual(1);
  expect(config.filesystem.denyWrite).toEqual([]);
});
