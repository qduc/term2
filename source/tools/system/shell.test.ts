import { it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createShellToolDefinition } from './shell.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { ExecutionContext } from '../../services/execution-context.js';
import type { ILoggingService, ISSHService } from '../../services/service-interfaces.js';

function createFakeSandboxRunner(overrides: Partial<any> = {}): any {
  return {
    availability: async () => ({ type: 'available' }),
    wrap: async (command: string) => ({ command: `sandboxed(${command})` }),
    cleanupAfterCommand: async () => {},
    annotateFailure: (_command: string, stderr: string) => stderr,
    ...overrides,
  };
}

function createNoopLogger(overrides: Partial<ILoggingService> = {}): ILoggingService {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    getCorrelationId: () => undefined,
    clearCorrelationId: () => {},
    ...overrides,
  };
}

function createTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-shell-test-'));

  return dir;
}

function createFakeRtk(): string {
  const dir = createTmpDir();
  const rtkPath = path.join(dir, 'rtk');
  fs.writeFileSync(rtkPath, '#!/bin/sh\nexec "$@"\n');
  fs.chmodSync(rtkPath, 0o755);
  return rtkPath;
}

it.sequential('shell execute appends spill-file guidance when output is truncated', async () => {
  const longStdout = `${'x'.repeat(6000)}FULL-ONLY-SENTINEL${'y'.repeat(6000)}`;

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
    executeShellCommandImpl: async () => ({
      stdout: longStdout,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }),
  });

  const output = await tool.execute({
    command: 'demo --long-output',
    timeout_ms: 60000,
    max_output_length: 120,
  });

  expect(output.includes('Full output saved to')).toBe(true);
  expect(/Runtime: \d+ms/.test(output)).toBe(true);
  expect(output.includes('FULL-ONLY-SENTINEL')).toBe(false);
});

it('shell description mentions saved long output and avoiding reruns', () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
  });

  expect(tool.description.includes('Long output is saved to a file')).toBe(true);
});

it('shell schema accepts omitted, default, and unsandboxed sandbox modes', () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
  });

  expect(tool.parameters.parse({ command: 'pwd' }).sandbox).toBe('default');
  expect(tool.parameters.parse({ command: 'pwd', sandbox: 'default' }).sandbox).toBe('default');
  expect(tool.parameters.parse({ command: 'pwd', sandbox: 'unsandboxed' }).sandbox).toBe('unsandboxed');
  expect(() => tool.parameters.parse({ command: 'pwd', sandbox: 'off' })).toThrow();
});

it('shell needsApproval always prompts for unsandboxed execution', async () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
  });

  expect(await tool.needsApproval({ command: 'ls', sandbox: 'unsandboxed' })).toBe(true);
});

it.sequential('shell execute restores previous correlation id after command execution', async () => {
  let clearCorrelationCalls = 0;
  let currentCorrelationId: string | undefined = 'trace-parent';

  const loggingService: ILoggingService = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: (id: string | undefined) => {
      currentCorrelationId = id;
    },
    getCorrelationId: () => currentCorrelationId,
    clearCorrelationId: () => {
      currentCorrelationId = undefined;
      clearCorrelationCalls += 1;
    },
  };

  const tool = createShellToolDefinition({
    loggingService,
    settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
  });

  const output = await tool.execute({
    command: 'printf hello',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(output.includes('exit 0')).toBe(true);
  expect(currentCorrelationId).toBe('trace-parent');
  expect(clearCorrelationCalls).toBe(0);
});

it.sequential('shell execute clears correlation id when no previous correlation exists', async () => {
  let currentCorrelationId: string | undefined = undefined;
  let clearCorrelationCalls = 0;

  const loggingService: ILoggingService = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: (id: string | undefined) => {
      currentCorrelationId = id;
    },
    getCorrelationId: () => currentCorrelationId,
    clearCorrelationId: () => {
      currentCorrelationId = undefined;
      clearCorrelationCalls += 1;
    },
  };

  const tool = createShellToolDefinition({
    loggingService,
    settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
  });

  await tool.execute({
    command: 'printf hello',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(currentCorrelationId).toBe(undefined);
  expect(clearCorrelationCalls).toBe(1);
});

it.sequential('shell execute stops a running command when the tool invocation is aborted', async () => {
  const abortController = new AbortController();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
  });

  const outputPromise = tool.execute(
    {
      command: 'sleep 1; printf finished',
      timeout_ms: 60000,
      max_output_length: 10000,
    },
    undefined,
    { signal: abortController.signal },
  );

  queueMicrotask(() => abortController.abort());
  const output = await outputPromise;

  expect(output.startsWith('timeout')).toBe(true);
  expect(output.includes('finished')).toBe(false);
});

it.sequential('shell execute does not install RTK for unsupported commands', async () => {
  let installCalled = false;

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true, 'sandbox.enabled': false }),
    rtkInstaller: async () => {
      installCalled = true;
      return '/tmp/rtk';
    },
  });

  const output = await tool.execute({
    command: 'printf hello',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(output.includes('exit 0')).toBe(true);
  expect(installCalled).toBe(false);
});

it.sequential('shell execute wraps eligible RTK commands', async () => {
  let installCalled = false;
  let wrappedCommand: string | undefined;
  const rtkPath = createFakeRtk();

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger({
      debug: (message: string, meta?: any) => {
        if (message === 'Wrapped command with rtk') {
          wrappedCommand = meta?.original;
        }
      },
    }),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true, 'sandbox.enabled': false }),
    rtkInstaller: async () => {
      installCalled = true;
      return rtkPath;
    },
  });

  const output = await tool.execute({
    command: 'ls package.json',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(output.includes('package.json')).toBe(true);
  expect(installCalled).toBe(true);
  expect(wrappedCommand).toBe('ls package.json');
});

it.sequential('shell execute does not install RTK for allowlisted commands in a pipeline', async () => {
  let installCalled = false;

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true, 'sandbox.enabled': false }),
    rtkInstaller: async () => {
      installCalled = true;
      return createFakeRtk();
    },
  });

  const output = await tool.execute({
    command: 'cat package.json | head -n 1',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(output.includes('exit 0')).toBe(true);
  expect(installCalled).toBe(false);
});

it.sequential('shell execute does not install RTK for allowlisted commands redirected to files', async () => {
  let installCalled = false;
  const dir = createTmpDir();
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stderrPath = path.join(dir, 'stderr.txt');

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true, 'sandbox.enabled': false }),
    rtkInstaller: async () => {
      installCalled = true;
      return createFakeRtk();
    },
  });

  const stdoutRedirect = await tool.execute({
    command: `cat package.json > ${stdoutPath}`,
    timeout_ms: 60000,
    max_output_length: 10000,
  });
  const stderrRedirect = await tool.execute({
    command: `ls ${path.join(dir, 'missing')} 2> ${stderrPath}`,
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(stdoutRedirect.includes('exit 0')).toBe(true);
  expect(stderrRedirect.includes('exit 1') || stderrRedirect.includes('exit 2')).toBe(true); // Different variants of ls can return either exit 1 or exit 2
  expect(fs.existsSync(stdoutPath)).toBe(true);
  expect(fs.existsSync(stderrPath)).toBe(true);
  expect(installCalled).toBe(false);
});

it.sequential('shell execute bypasses RTK for SSH commands', async () => {
  let installCalled = false;
  let executedCommand: string | undefined;
  const sshService: ISSHService = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    executeCommand: async (cmd: string) => {
      executedCommand = cmd;
      return { stdout: 'remote\n', stderr: '', exitCode: 0, timedOut: false };
    },
    readFile: async () => '',
    writeFile: async () => {},
    mkdir: async () => {},
  };

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true }),
    executionContext: new ExecutionContext(sshService, '/remote/workspace'),
    rtkInstaller: async () => {
      installCalled = true;
      return createFakeRtk();
    },
  });

  const output = await tool.execute({
    command: 'ls package.json',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(output.includes('remote')).toBe(true);
  expect(executedCommand).toBe('ls package.json');
  expect(installCalled).toBe(false);
});

it.sequential('shell execute wraps local default commands with the sandbox when enabled and available', async () => {
  let executedCommand: string | undefined;
  let receivedEnv: NodeJS.ProcessEnv | undefined;
  let wrappedCommand: string | undefined;
  let receivedReadPolicy: string | undefined;
  let receivedAllowReadExtra: string[] | undefined;
  let cleanupCalls = 0;
  const runner = createFakeSandboxRunner({
    wrap: async (command: string, options: any) => {
      wrappedCommand = command;
      receivedReadPolicy = options.config?.filesystem?.allowRead ? 'home-denylist' : 'credential-denylist';
      receivedAllowReadExtra = options.config?.filesystem?.allowRead;
      return { command: `sandboxed(${command})`, diagnostics: ['sandbox active'] };
    },
    cleanupAfterCommand: async () => {
      cleanupCalls += 1;
    },
  });

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({
      'sandbox.enabled': true,
      'sandbox.readPolicy': 'home-denylist',
      'sandbox.allowReadExtra': ['/tmp/tool-cache'],
    }),
    shellSandboxRunner: runner,
    executeShellCommandImpl: async (command, options) => {
      executedCommand = command;
      receivedEnv = options?.env;
      return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
    },
  });

  const output = await tool.execute({ command: 'pwd', sandbox: 'default' });

  expect(wrappedCommand).toBe('pwd');
  expect(receivedReadPolicy).toBe('home-denylist');
  expect(receivedAllowReadExtra).toContain('/tmp/tool-cache');
  expect(executedCommand).toBe('sandboxed(pwd)');
  expect(receivedEnv).toBeTruthy();
  expect(cleanupCalls).toBe(1);
  expect(output.includes('ok')).toBe(true);
});

it.sequential('shell execute bypasses sandbox for SSH commands', async () => {
  let sandboxWrapped = false;
  let executedCommand: string | undefined;
  const sshService: ISSHService = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    executeCommand: async (cmd: string) => {
      executedCommand = cmd;
      return { stdout: 'remote', stderr: '', exitCode: 0, timedOut: false };
    },
    readFile: async () => '',
    writeFile: async () => {},
    mkdir: async () => {},
  };

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    executionContext: new ExecutionContext(sshService, '/remote/workspace'),
    shellSandboxRunner: createFakeSandboxRunner({
      wrap: async () => {
        sandboxWrapped = true;
        return { command: 'sandboxed' };
      },
    }),
  });

  const output = await tool.execute({ command: 'pwd', sandbox: 'default' });

  expect(sandboxWrapped).toBe(false);
  expect(executedCommand).toBe('pwd');
  expect(output.includes('remote')).toBe(true);
});

it.sequential('shell execute bypasses sandbox when disabled', async () => {
  let sandboxWrapped = false;
  let executedCommand: string | undefined;
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': false }),
    shellSandboxRunner: createFakeSandboxRunner({
      wrap: async () => {
        sandboxWrapped = true;
        return { command: 'sandboxed' };
      },
    }),
    executeShellCommandImpl: async (command) => {
      executedCommand = command;
      return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
    },
  });

  await tool.execute({ command: 'pwd', sandbox: 'default' });

  expect(sandboxWrapped).toBe(false);
  expect(executedCommand).toBe('pwd');
});

it('shell needsApproval prompts for default commands when sandbox is unavailable', async () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner({
      availability: async () => ({ type: 'unsupported_platform', reason: 'not supported' }),
    }),
  });

  expect(await tool.needsApproval({ command: 'pwd', sandbox: 'default' })).toBe(true);
});

it.sequential('shell execute runs unsandboxed when sandbox is unavailable after approval', async () => {
  let sandboxWrapped = false;
  let executedCommand: string | undefined;
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner({
      availability: async () => ({ type: 'unsupported_platform', reason: 'not supported' }),
      wrap: async () => {
        sandboxWrapped = true;
        return { command: 'sandboxed' };
      },
    }),
    executeShellCommandImpl: async (command) => {
      executedCommand = command;
      return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
    },
  });

  await tool.execute({ command: 'pwd', sandbox: 'default' });

  expect(sandboxWrapped).toBe(false);
  expect(executedCommand).toBe('pwd');
});

it.sequential('shell execute fails closed when sandbox wrapping fails', async () => {
  let executedCommand: string | undefined;
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner({
      wrap: async () => {
        throw new Error('init failed');
      },
    }),
    executeShellCommandImpl: async (command) => {
      executedCommand = command;
      return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false };
    },
  });

  const output = await tool.execute({ command: 'pwd', sandbox: 'default' });

  expect(executedCommand).toBeUndefined();
  expect(output).toContain('Sandbox blocked this command');
  expect(output).toContain('sandbox="unsandboxed"');
});

it.sequential('shell execute appends retry instruction when sandbox annotates a denial', async () => {
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'sandbox.enabled': true }),
    shellSandboxRunner: createFakeSandboxRunner({
      annotateFailure: (_command: string, stderr: string) => `${stderr}\nSandbox violation: network denied`,
    }),
    executeShellCommandImpl: async () => ({
      stdout: '',
      stderr: 'curl: failed',
      exitCode: 1,
      timedOut: false,
    }),
  });

  const output = await tool.execute({ command: 'curl https://example.com', sandbox: 'default' });

  expect(output.includes('Sandbox violation: network denied')).toBe(true);
  expect(output.includes('Sandbox blocked this command')).toBe(true);
  expect(output.includes('sandbox="unsandboxed"')).toBe(true);
});

it.sequential('shell execute in plan mode blocks mutating commands but runs green commands', async () => {
  const settingsService = createMockSettingsService({
    'app.planMode': true,
    'sandbox.enabled': false,
  });

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService,
  });

  // Mutating command: touch (normally returns error directly without running)
  const outputMutating = await tool.execute({
    command: 'touch /tmp/somefile_plan_mode_test',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(outputMutating.includes('plan mode is read-only')).toBe(true);
  expect(outputMutating.includes('Command not executed')).toBe(true);

  // Green command: echo hello
  const outputGreen = await tool.execute({
    command: 'echo hello_plan_mode_test',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  expect(outputGreen.includes('hello_plan_mode_test')).toBe(true);
  expect(outputGreen.includes('exit 0')).toBe(true);
});

it.sequential('shell needsApproval classifications in planMode false', async () => {
  const settingsService = createMockSettingsService({
    'app.planMode': false,
    'sandbox.enabled': false,
  });

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService,
  });

  expect(await tool.needsApproval({ command: 'touch /tmp/somefile_test' })).toBe(true);
  expect(await tool.needsApproval({ command: 'ls' })).toBe(false);
});
