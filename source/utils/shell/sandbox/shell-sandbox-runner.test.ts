import { expect, it, vi } from 'vitest';

const sandboxManager = vi.hoisted(() => {
  let activeConfig: { network?: { allowUnixSockets?: string[] } } | undefined;
  let releaseFirstInitialize: (() => void) | undefined;
  let firstInitializeStarted: (() => void) | undefined;
  let initializeCount = 0;

  const firstInitialize = new Promise<void>((resolve) => {
    releaseFirstInitialize = resolve;
  });
  const initialized = new Promise<void>((resolve) => {
    firstInitializeStarted = resolve;
  });

  return {
    isSupportedPlatform: vi.fn(() => true),
    checkDependencies: vi.fn(() => ({ errors: [] })),
    initialize: vi.fn(async (config: { network?: { allowUnixSockets?: string[] } }) => {
      if (initializeCount++ === 0) {
        activeConfig = config;
        firstInitializeStarted?.();
        await firstInitialize;
      }
    }),
    reset: vi.fn(async () => {
      activeConfig = undefined;
    }),
    wrapWithSandbox: vi.fn(async (command: string) => {
      const socketAccess = activeConfig?.network?.allowUnixSockets?.includes('/tmp/docker.sock') === true;
      return `${socketAccess ? 'docker-enabled' : 'ordinary'}:${command}`;
    }),
    getLinuxGlobPatternWarnings: vi.fn(() => []),
    cleanupAfterCommand: vi.fn(),
    annotateStderrWithSandboxFailures: vi.fn((_command: string, stderr: string) => stderr),
    waitForFirstInitialize: () => initialized,
    releaseFirstInitialize: () => releaseFirstInitialize?.(),
  };
});

vi.mock('@anthropic-ai/sandbox-runtime', () => ({ SandboxManager: sandboxManager }));

import { AnthropicShellSandboxRunner } from './shell-sandbox-runner.js';

it('does not let a concurrent ordinary wrap inherit Docker socket access', async () => {
  const runner = new AnthropicShellSandboxRunner();
  const dockerWrap = runner.wrap('docker-command', {
    cwd: '/workspace',
    config: {
      network: {
        allowUnixSockets: ['/tmp/docker.sock'],
      },
    } as any,
  });

  await sandboxManager.waitForFirstInitialize();
  const ordinaryWrap = runner.wrap('ordinary-command', {
    cwd: '/workspace',
    config: {
      network: {},
    } as any,
  });
  sandboxManager.releaseFirstInitialize();

  await expect(dockerWrap).resolves.toMatchObject({ command: 'docker-enabled:docker-command' });
  await expect(ordinaryWrap).resolves.toMatchObject({ command: 'ordinary:ordinary-command' });
});
