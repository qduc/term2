import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createShellToolDefinition } from './shell.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';
import { ExecutionContext } from '../services/execution-context.js';
import type { ILoggingService, ISSHService } from '../services/service-interfaces.js';

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

function createTmpDir(t: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-shell-test-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createFakeRtk(t: any): string {
  const dir = createTmpDir(t);
  const rtkPath = path.join(dir, 'rtk');
  fs.writeFileSync(rtkPath, '#!/bin/sh\nexec "$@"\n');
  fs.chmodSync(rtkPath, 0o755);
  return rtkPath;
}

function createMockSandboxSession(overrides: Partial<Record<string, any>> = {}): any {
  return {
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    stop: async () => {},
    shutdown: async () => {},
    delete: async () => {},
    close: async () => {},
    ...overrides,
  };
}

function createSandboxExecutionContext(session: any, counter?: { createCount: number }): ExecutionContext {
  return new ExecutionContext(undefined, undefined, {
    sandboxClientFactory: () => ({
      create: async () => {
        if (counter) {
          counter.createCount += 1;
        }
        return session;
      },
    }),
  });
}

test.serial('shell execute restores previous correlation id after command execution', async (t) => {
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
    settingsService: createMockSettingsService(),
  });

  const output = await tool.execute({
    command: 'printf hello',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  t.true(output.includes('exit 0'));
  t.is(currentCorrelationId, 'trace-parent');
  t.is(clearCorrelationCalls, 0);
});

test.serial('shell execute clears correlation id when no previous correlation exists', async (t) => {
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
    settingsService: createMockSettingsService(),
  });

  await tool.execute({
    command: 'printf hello',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  t.is(currentCorrelationId, undefined);
  t.is(clearCorrelationCalls, 1);
});

test.serial('shell execute stops a running command when the tool invocation is aborted', async (t) => {
  const abortController = new AbortController();
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
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

  t.true(output.startsWith('timeout'));
  t.false(output.includes('finished'));
});

test.serial('shell execute does not install RTK for unsupported commands', async (t) => {
  let installCalled = false;

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true }),
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

  t.true(output.includes('exit 0'));
  t.false(installCalled);
});

test.serial('shell execute wraps eligible RTK commands', async (t) => {
  let installCalled = false;
  let wrappedCommand: string | undefined;
  const rtkPath = createFakeRtk(t);

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger({
      debug: (message: string, meta?: any) => {
        if (message === 'Wrapped command with rtk') {
          wrappedCommand = meta?.original;
        }
      },
    }),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true }),
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

  t.true(output.includes('package.json'));
  t.true(installCalled);
  t.is(wrappedCommand, 'ls package.json');
});

test.serial('shell execute does not install RTK for allowlisted commands in a pipeline', async (t) => {
  let installCalled = false;

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true }),
    rtkInstaller: async () => {
      installCalled = true;
      return createFakeRtk(t);
    },
  });

  const output = await tool.execute({
    command: 'cat package.json | head -n 1',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  t.true(output.includes('exit 0'));
  t.false(installCalled);
});

test.serial('shell execute does not install RTK for allowlisted commands redirected to files', async (t) => {
  let installCalled = false;
  const dir = createTmpDir(t);
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stderrPath = path.join(dir, 'stderr.txt');

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true }),
    rtkInstaller: async () => {
      installCalled = true;
      return createFakeRtk(t);
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

  t.true(stdoutRedirect.includes('exit 0'));
  t.true(stderrRedirect.includes('exit 1') || stderrRedirect.includes('exit 2')); // Different variants of ls can return either exit 1 or exit 2
  t.true(fs.existsSync(stdoutPath));
  t.true(fs.existsSync(stderrPath));
  t.false(installCalled);
});

test.serial('shell execute bypasses RTK for SSH commands', async (t) => {
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
      return createFakeRtk(t);
    },
  });

  const output = await tool.execute({
    command: 'ls package.json',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  t.true(output.includes('remote'));
  t.is(executedCommand, 'ls package.json');
  t.false(installCalled);
});

test.serial('shell execute in plan mode blocks mutating commands but runs green commands', async (t) => {
  const settingsService = createMockSettingsService({
    'app.planMode': true,
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

  t.true(outputMutating.includes('plan mode is read-only'));
  t.true(outputMutating.includes('Command not executed'));

  // Green command: echo hello
  const outputGreen = await tool.execute({
    command: 'echo hello_plan_mode_test',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  t.true(outputGreen.includes('hello_plan_mode_test'));
  t.true(outputGreen.includes('exit 0'));
});

test.serial('shell needsApproval classifications in planMode false', async (t) => {
  const settingsService = createMockSettingsService({
    'app.planMode': false,
  });

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService,
  });

  t.true(await tool.needsApproval({ command: 'touch /tmp/somefile_test' }));
  t.false(await tool.needsApproval({ command: 'ls' }));
});

test.serial('shell execute routes sandbox-required commands to local sandbox session', async (t) => {
  let installCalled = false;
  let execArgs: any;
  const session = createMockSandboxSession({
    exec: async (args: any) => {
      execArgs = args;
      return { stdout: 'sandbox\n', stderr: '', exitCode: 0 };
    },
  });
  const executionContext = createSandboxExecutionContext(session);

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.useRtkCompression': true }),
    executionContext,
    rtkInstaller: async () => {
      installCalled = true;
      return createFakeRtk(t);
    },
  });

  const output = await tool.execute({
    command: 'node -e "console.log(\'sandbox\')"',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  t.true(output.includes('exit 0'));
  t.true(output.includes('sandbox'));
  t.deepEqual(execArgs, {
    cmd: 'node -e "console.log(\'sandbox\')"',
    workdir: executionContext.getSandboxWorkdir(),
    yieldTimeMs: 60000,
  });
  t.false(installCalled);
});

test.serial('shell needsApproval respects auto-allow sandboxed commands locally', async (t) => {
  const localTool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.autoAllowSandboxedCommands': false }),
    executionContext: new ExecutionContext(),
  });

  const autoAllowTool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'shell.autoAllowSandboxedCommands': true }),
    executionContext: new ExecutionContext(),
  });

  t.true(await localTool.needsApproval({ command: 'node -e "console.log(1)"' }));
  t.false(await autoAllowTool.needsApproval({ command: 'node -e "console.log(1)"' }));
});

test.serial('shell execute keeps sandbox-required commands on SSH host path', async (t) => {
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
    settingsService: createMockSettingsService({
      'shell.useRtkCompression': true,
      'shell.autoAllowSandboxedCommands': true,
    }),
    executionContext: new ExecutionContext(sshService, '/remote/workspace'),
    rtkInstaller: async () => {
      installCalled = true;
      return createFakeRtk(t);
    },
  });

  const output = await tool.execute({
    command: 'node -e "console.log(1)"',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  t.true(output.includes('remote'));
  t.is(executedCommand, 'node -e "console.log(1)"');
  t.false(installCalled);
  t.true(await tool.needsApproval({ command: 'node -e "console.log(1)"' }));
});

test.serial('shell execute blocks sandbox-required commands before sandbox creation in plan mode', async (t) => {
  let createCount = 0;
  const executionContext = new ExecutionContext(undefined, undefined, {
    sandboxClientFactory: () => ({
      create: async () => {
        createCount += 1;
        return createMockSandboxSession();
      },
    }),
  });

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService({ 'app.planMode': true }),
    executionContext,
  });

  const output = await tool.execute({
    command: 'node -e "console.log(1)"',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  t.true(output.includes('plan mode is read-only'));
  t.is(createCount, 0);
});

test.serial('shell execute returns timeout output and stops the sandbox process', async (t) => {
  let stopCount = 0;
  const session = createMockSandboxSession({
    exec: async () => ({ stdout: 'partial\n', stderr: '', exitCode: null, sessionId: 1 }),
    stop: async () => {
      stopCount += 1;
    },
  });
  const executionContext = createSandboxExecutionContext(session);

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
    executionContext,
  });

  const output = await tool.execute({
    command: 'node -e "console.log(1)"',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  t.true(output.startsWith('timeout'));
  t.true(output.includes('partial'));
  t.is(stopCount, 1);
});

test.serial('shell execute aborts sandbox execution and stops the sandbox process', async (t) => {
  let stopCount = 0;
  const session = createMockSandboxSession({
    exec: async () => new Promise(() => {}),
    stop: async () => {
      stopCount += 1;
    },
  });
  const executionContext = createSandboxExecutionContext(session);
  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
    executionContext,
  });

  const abortController = new AbortController();
  const outputPromise = tool.execute(
    {
      command: 'node -e "console.log(1)"',
      timeout_ms: 60000,
      max_output_length: 10000,
    },
    undefined,
    { signal: abortController.signal },
  );

  queueMicrotask(() => abortController.abort());
  const output = await outputPromise;

  t.true(output.startsWith('timeout'));
  t.is(stopCount, 1);
});

test.serial('shell execute returns an explicit error when sandbox creation fails', async (t) => {
  const executionContext = new ExecutionContext(undefined, undefined, {
    sandboxClientFactory: () => ({
      create: async () => {
        throw new Error('sandbox unavailable');
      },
    }),
  });

  const tool = createShellToolDefinition({
    loggingService: createNoopLogger(),
    settingsService: createMockSettingsService(),
    executionContext,
  });

  const output = await tool.execute({
    command: 'node -e "console.log(1)"',
    timeout_ms: 60000,
    max_output_length: 10000,
  });

  t.true(output.includes('Error: failed to execute sandboxed shell command: sandbox unavailable'));
});
