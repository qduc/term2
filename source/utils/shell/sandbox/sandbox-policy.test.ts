import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSandboxRuntimeConfig, isPathProtected } from './sandbox-policy.js';
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

it('createSandboxRuntimeConfig keeps standard reads compatible by default', () => {
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

it('createSandboxRuntimeConfig denies home and named system reads with workspace carve-outs for strict', () => {
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
    readPolicy: 'strict',
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

it('createSandboxRuntimeConfig filters exact-only protected paths (cwd = $HOME) from allowWrite', () => {
  const home = os.homedir();
  const config = createSandboxRuntimeConfig({ cwd: home });
  expect(config.filesystem.allowWrite).not.toContain(home);
  // tmpDir is typically under /tmp, which is not protected.
  expect(config.filesystem.allowWrite).toEqual(expect.arrayContaining([SANDBOX_TEMP_DIR]));
});

it('createSandboxRuntimeConfig keeps $HOME descendants writable (e.g. ~/projects/foo)', () => {
  // Use a real existing descendant of home if possible; fall back to a
  // synthetic non-existent path that realpathSync can still resolve (it
  // cannot, so we just check the policy does not over-match by shape).
  const home = os.homedir();
  const child = path.join(home, '.cache');
  if (!fs.existsSync(child)) return; // environment without .cache; skip
  const config = createSandboxRuntimeConfig({ cwd: child });
  expect(config.filesystem.allowWrite).toEqual(expect.arrayContaining([fs.realpathSync(child), SANDBOX_TEMP_DIR]));
});

it('createSandboxRuntimeConfig filters subtree /etc from allowWrite', () => {
  if (!fs.existsSync('/etc')) return; // environment without /etc; skip
  const configEtcRoot = createSandboxRuntimeConfig({ cwd: '/etc' });
  expect(configEtcRoot.filesystem.allowWrite).not.toContain('/etc');
  expect(configEtcRoot.filesystem.allowWrite).toEqual(expect.arrayContaining([SANDBOX_TEMP_DIR]));
});

it('isPathProtected keeps /usr/local and descendants writable (documented exception)', () => {
  const home = os.homedir();
  // /usr/local is a documented writable carve-out inside the /usr subtree.
  expect(isPathProtected('/usr/local', home)).toBe(false);
  expect(isPathProtected('/usr/local/src', home)).toBe(false);
  expect(isPathProtected('/usr/local/foo/bar', home)).toBe(false);
  // /usr itself and other /usr descendants remain subtree-protected.
  expect(isPathProtected('/usr', home)).toBe(true);
  expect(isPathProtected('/usr/bin', home)).toBe(true);
});

it('isPathProtected guards home even when the home dir is a symlink path', () => {
  const home = os.homedir();
  // The protected home entry is normalized the same way workspaceRoot is
  // (realpath), so it matches the realpath-resolved workspace when launched
  // from a symlinked $HOME.
  const realHome = fs.existsSync(home) ? fs.realpathSync(home) : path.resolve(home);
  expect(isPathProtected(realHome, home)).toBe(true);
  expect(isPathProtected(path.join(realHome, 'projects'), home)).toBe(false);
});

it('createSandboxRuntimeConfig invokes onProtectedFiltered callback with filtered paths', () => {
  const home = os.homedir();
  const filtered: string[][] = [];
  createSandboxRuntimeConfig({
    cwd: home,
    onProtectedFiltered: (paths) => filtered.push([...paths]),
  });
  expect(filtered).toEqual([[home]]);
});

it('createSandboxRuntimeConfig does not invoke onProtectedFiltered when nothing is filtered', () => {
  // /tmp is never in the protected list; if it doesn't exist on this machine,
  // fall back to the system tmpdir (also typically not protected).
  const safeCwd = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  let invoked = false;
  createSandboxRuntimeConfig({
    cwd: safeCwd,
    onProtectedFiltered: () => {
      invoked = true;
    },
  });
  expect(invoked).toBe(false);
});

it('createSandboxRuntimeConfig does not modify allowRead or denyRead when filtering allowWrite', () => {
  const home = os.homedir();
  const config = createSandboxRuntimeConfig({
    cwd: home,
    readPolicy: 'strict',
  });
  // /etc, /var, /root, /private/var are still in denyRead (unrelated to write filter)
  expect(config.filesystem.denyRead).toEqual(expect.arrayContaining([home, '/etc', '/var', '/root', '/private/var']));
  // allowRead still contains the same system tool paths as before the change.
  expect(config.filesystem.allowRead).toEqual(expect.arrayContaining(['/usr', '/bin', '/opt']));
});

it('createSandboxRuntimeConfig denies all network by default', () => {
  const config = createSandboxRuntimeConfig();
  expect(config.network.deniedDomains).toEqual(['*']);
  expect(config.network.strictAllowlist).toBe(true);
  expect(config.network.allowLocalBinding).toBe(false);
  expect(config.network.allowedDomains).toEqual(
    expect.arrayContaining(['registry.npmjs.org', 'pypi.org', 'raw.githubusercontent.com']),
  );
});

it('createSandboxRuntimeConfig uses allowlist auto-allow and asks for non-allowlisted hosts when allowNetworking is true', () => {
  const config = createSandboxRuntimeConfig({ allowNetworking: true });
  expect(config.network.deniedDomains).toEqual([]);
  expect(config.network.strictAllowlist).toBe(false);
  expect(config.network.allowLocalBinding).toBe(true);
  expect(config.network.allowedDomains).toEqual(
    expect.arrayContaining(['registry.npmjs.org', 'pypi.org', 'raw.githubusercontent.com']),
  );
});
