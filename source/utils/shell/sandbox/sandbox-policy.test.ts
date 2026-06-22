import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSandboxRuntimeConfig } from './sandbox-policy.js';
import { SANDBOX_TEMP_DIR } from '../temp-dir.js';

it('createSandboxRuntimeConfig allows writing to the shared sandbox temp dir', () => {
  const config = createSandboxRuntimeConfig();

  expect(config.filesystem.allowWrite).toContain(SANDBOX_TEMP_DIR);
});

it('createSandboxRuntimeConfig resolves workspace and denies credential files', () => {
  const config = createSandboxRuntimeConfig();

  expect(config.filesystem.allowWrite).toContain(fs.realpathSync(process.cwd()));
  expect(config.filesystem.allowWrite).not.toContain('.');
  expect(config.filesystem.denyWrite).toEqual([]);
});

it('createSandboxRuntimeConfig keeps credential-denylist reads compatible by default', () => {
  const home = os.homedir();
  const config = createSandboxRuntimeConfig();

  expect(config.filesystem.denyRead).toContain(path.join(home, '.ssh'));
  expect(config.filesystem.denyRead).not.toContain(home);
  expect(config.filesystem.allowRead).toBeUndefined();
});

it('createSandboxRuntimeConfig denies every present secret-shaped environment variable', () => {
  const config = createSandboxRuntimeConfig({
    env: {
      PATH: '/usr/bin',
      NPM_TOKEN: 'secret',
      CUSTOM_API_KEY: 'secret',
      DATABASE_SECRET: 'secret',
      JAVA_HOME: '/usr/lib/jvm/default',
    },
  });
  expect(config.credentials).toBeDefined();

  expect(config.credentials!.envVars).toEqual(
    expect.arrayContaining([
      { name: 'NPM_TOKEN', mode: 'deny' },
      { name: 'CUSTOM_API_KEY', mode: 'deny' },
      { name: 'DATABASE_SECRET', mode: 'deny' },
    ]),
  );
  expect(config.credentials!.envVars).not.toContainEqual({ name: 'JAVA_HOME', mode: 'deny' });
});

it('createSandboxRuntimeConfig denies home and named system reads with workspace carve-outs for home-denylist', () => {
  const home = os.homedir();
  const workspaceRoot = fs.realpathSync(process.cwd());
  const config = createSandboxRuntimeConfig({
    readPolicy: 'home-denylist',
    allowReadExtra: ['~/.local/share/pnpm/store'],
  });

  expect(config.filesystem.denyRead).toEqual(expect.arrayContaining([home, '/etc', '/var', '/root', '/private/var']));
  expect(config.filesystem.allowRead).toEqual(
    expect.arrayContaining([
      workspaceRoot,
      SANDBOX_TEMP_DIR,
      path.join(home, '.local', 'share', 'pnpm', 'store'),
      '/usr',
      '/bin',
      '/sbin',
      '/lib',
      '/lib64',
      '/opt',
      '/Library',
      '/System/Library',
      '/usr/local',
      '/opt/homebrew',
    ]),
  );
  expect(config.filesystem.allowRead).not.toContain(home);
  expect(config.filesystem.allowWrite).toEqual(expect.arrayContaining([workspaceRoot, SANDBOX_TEMP_DIR]));
});
