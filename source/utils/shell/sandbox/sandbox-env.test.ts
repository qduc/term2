import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSandboxEnvironment } from './sandbox-env.js';
import { SANDBOX_TEMP_DIR } from '../temp-dir.js';

it('keeps minimal shell environment and strips secret patterns', () => {
  const env = createSandboxEnvironment({
    PATH: '/usr/bin:/bin',
    SHELL: '/bin/zsh',
    TMPDIR: '/tmp/example',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    NODE_ENV: 'test',
    FOO_API_KEY: 'secret',
    SERVICE_TOKEN: 'secret',
    DATABASE_SECRET: 'secret',
    AWS_ACCESS_KEY_ID: 'secret',
    GOOGLE_APPLICATION_CREDENTIALS: '/secret.json',
    GCP_PROJECT: 'secret-project',
    AZURE_TENANT_ID: 'secret',
    OPENAI_API_KEY: 'secret',
    ANTHROPIC_API_KEY: 'secret',
    GITHUB_TOKEN: 'secret',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    SSH_AGENT_PID: '123',
    CUSTOM_VALUE: 'not-allowed-by-default',
  });

  expect(env.PATH).toBe('/usr/bin:/bin');
  expect(env.SHELL).toBe('/bin/zsh');
  expect(env.TMPDIR).toBe('/tmp/example');
  expect(env.TERM).toBe('xterm-256color');
  expect(env.LANG).toBe('en_US.UTF-8');
  expect(env.LC_ALL).toBe('en_US.UTF-8');
  expect(env.NODE_ENV).toBeUndefined();
  expect(env.FOO_API_KEY).toBeUndefined();
  expect(env.SERVICE_TOKEN).toBeUndefined();
  expect(env.DATABASE_SECRET).toBeUndefined();
  expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
  expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  expect(env.GCP_PROJECT).toBeUndefined();
  expect(env.AZURE_TENANT_ID).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.SSH_AUTH_SOCK).toBeUndefined();
  expect(env.SSH_AGENT_PID).toBeUndefined();
  expect(env.CUSTOM_VALUE).toBeUndefined();
});

it('synthesizes private sandbox XDG paths in strict mode', () => {
  const cwd = process.cwd();
  const env = createSandboxEnvironment(
    {
      PATH: '/usr/bin:/bin',
      HOME: os.homedir(),
      XDG_CONFIG_HOME: '/host/config',
      XDG_CACHE_HOME: '/host/cache',
      XDG_DATA_HOME: '/host/data',
      XDG_STATE_HOME: '/host/state',
    },
    { cwd, readPolicy: 'strict' },
  );

  const expectedRoot = path.join(SANDBOX_TEMP_DIR, 'xdg');

  expect(env.HOME).toBe(os.homedir());
  expect(env.XDG_CONFIG_HOME).toBeDefined();
  expect(env.XDG_CACHE_HOME).toBeDefined();
  expect(env.XDG_DATA_HOME).toBeDefined();
  expect(env.XDG_STATE_HOME).toBeDefined();
  expect(env.XDG_CONFIG_HOME).not.toBe('/host/config');
  expect(env.XDG_CACHE_HOME).not.toBe('/host/cache');
  expect(env.XDG_DATA_HOME).not.toBe('/host/data');
  expect(env.XDG_STATE_HOME).not.toBe('/host/state');
  expect(env.XDG_CONFIG_HOME).toContain(expectedRoot);
  expect(env.XDG_CACHE_HOME).toContain(expectedRoot);
  expect(env.XDG_DATA_HOME).toContain(expectedRoot);
  expect(env.XDG_STATE_HOME).toContain(expectedRoot);
});

it('creates a private stable XDG layout per workspace', () => {
  const cwd = process.cwd();
  const env1 = createSandboxEnvironment({}, { cwd, readPolicy: 'strict' });
  const env2 = createSandboxEnvironment({}, { cwd, readPolicy: 'strict' });

  expect(env1.XDG_CACHE_HOME).toBe(env2.XDG_CACHE_HOME);
  expect(env1.XDG_CONFIG_HOME).toBe(env2.XDG_CONFIG_HOME);
  expect(env1.XDG_DATA_HOME).toBe(env2.XDG_DATA_HOME);
  expect(env1.XDG_STATE_HOME).toBe(env2.XDG_STATE_HOME);

  const xdgRoot = path.dirname(path.dirname(env1.XDG_CONFIG_HOME!));
  expect(fs.statSync(xdgRoot).mode & 0o777).toBe(0o700);

  for (const dir of [env1.XDG_CONFIG_HOME, env1.XDG_CACHE_HOME, env1.XDG_DATA_HOME, env1.XDG_STATE_HOME]) {
    expect(dir).toBeTruthy();
    expect(dir).toContain(SANDBOX_TEMP_DIR);
    const mode = fs.statSync(dir!).mode & 0o777;
    expect(mode).toBe(0o700);
  }
});

it('leaves sandbox env unchanged in standard mode', () => {
  const env = createSandboxEnvironment(
    {
      HOME: os.homedir(),
      XDG_CONFIG_HOME: '/host/config',
      XDG_CACHE_HOME: '/host/cache',
    },
    { cwd: process.cwd(), readPolicy: 'standard' },
  );

  expect(env.HOME).toBe(os.homedir());
  expect(env.XDG_CONFIG_HOME).toBeUndefined();
  expect(env.XDG_CACHE_HOME).toBeUndefined();
});
