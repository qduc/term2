import { it, expect } from 'vitest';
import { createSandboxEnvironment } from './sandbox-env.js';

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
