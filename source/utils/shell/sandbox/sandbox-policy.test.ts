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

it('createSandboxRuntimeConfig extends credential deny list with additional known credential paths', () => {
  const home = os.homedir();
  const config = createSandboxRuntimeConfig();

  expect(config.filesystem.denyRead).toEqual(
    expect.arrayContaining([
      path.join(home, '.ssh'),
      path.join(home, '.aws'),
      path.join(home, '.azure'),
      path.join(home, '.config', 'gcloud'),
      path.join(home, '.docker'),
      path.join(home, '.netrc'),
      path.join(home, '.git-credentials'),
      path.join(home, '.bash_history'),
      path.join(home, '.zsh_history'),
      path.join(home, '.npmrc'),
      path.join(home, '.pypirc'),
      path.join(home, '.kube'),
      path.join(home, '.gnupg'),
      path.join(home, '.config', 'gh'),
      path.join(home, '.gem'),
      path.join(home, '.gemrc'),
      path.join(home, '.config', 'hub'),
      path.join(home, '.docker', 'config.json'),
    ]),
  );
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
  const appCacheDir = path.join(home, '.cache', 'term2-nodejs');
  const rtkConfigDir = path.join(home, '.config', 'rtk');
  const rtkDataDir = path.join(home, '.local', 'share', 'rtk');
  const gitConfigFile = path.join(home, '.gitconfig');
  const gitConfigDir = path.join(home, '.config', 'git');
  const npmCacheDir = path.join(home, '.npm');
  const pnpmStoreDir = path.join(home, 'Library', 'pnpm');
  const pnpmStoreDirLinux = path.join(home, '.local', 'share', 'pnpm');
  const pnpmStoreDirLegacy = path.join(home, '.pnpm-store');
  const runtimeRoot = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
  const config = createSandboxRuntimeConfig({
    readPolicy: 'home-denylist',
    allowReadExtra: ['~/.local/share/pnpm/store'],
  });

  expect(config.filesystem.denyRead).toEqual(expect.arrayContaining([home, '/etc', '/var', '/root', '/private/var']));
  expect(config.filesystem.allowRead).toEqual(
    expect.arrayContaining([
      workspaceRoot,
      SANDBOX_TEMP_DIR,
      appCacheDir,
      rtkConfigDir,
      rtkDataDir,
      gitConfigFile,
      gitConfigDir,
      npmCacheDir,
      pnpmStoreDir,
      pnpmStoreDirLinux,
      pnpmStoreDirLegacy,
      runtimeRoot,
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
  expect(config.filesystem.allowRead).not.toContain(path.join(home, '.npmrc'));
  expect(config.filesystem.allowWrite).toEqual(expect.arrayContaining([workspaceRoot, SANDBOX_TEMP_DIR]));
});
