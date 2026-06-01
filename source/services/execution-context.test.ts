import test from 'ava';
import { ExecutionContext } from './execution-context.js';
import { ISSHService } from './service-interfaces.js';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

// Mock SSH service for testing
function createMockSSHService(): ISSHService {
  return {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    executeCommand: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    readFile: async () => '',
    writeFile: async () => {},
    mkdir: async () => {},
  };
}

function createMockSandboxSession(overrides: Partial<Record<string, any>> = {}): any {
  const close = overrides.close ?? (async () => {});
  return {
    state: {
      manifest: {
        root: '/workspace',
        entries: {},
      },
    },
    exec: async () => ({ output: '', stdout: '', stderr: '', wallTimeSeconds: 0, exitCode: 0 }),
    close,
    stop: async () => {},
    shutdown: async () => {},
    delete: async () => {},
    ...overrides,
  };
}

test('isRemote returns false when no SSH service provided', (t) => {
  const ctx = new ExecutionContext();
  t.false(ctx.isRemote());
});

test('isRemote returns true when SSH service provided', (t) => {
  const mockSSH = createMockSSHService();
  const ctx = new ExecutionContext(mockSSH, '/remote/path');
  t.true(ctx.isRemote());
});

test('getSSHService returns undefined when no SSH service', (t) => {
  const ctx = new ExecutionContext();
  t.is(ctx.getSSHService(), undefined);
});

test('getSSHService returns SSH service when provided', (t) => {
  const mockSSH = createMockSSHService();
  const ctx = new ExecutionContext(mockSSH, '/remote/path');
  t.is(ctx.getSSHService(), mockSSH);
});

test('getCwd returns process.cwd when not remote', (t) => {
  const ctx = new ExecutionContext();
  t.is(ctx.getCwd(), process.cwd());
});

test('getCwd returns remoteDir when in remote mode', (t) => {
  const mockSSH = createMockSSHService();
  const remoteDir = '/home/user/project';
  const ctx = new ExecutionContext(mockSSH, remoteDir);
  t.is(ctx.getCwd(), remoteDir);
});

test('getCwd returns process.cwd when remote but no remoteDir', (t) => {
  const mockSSH = createMockSSHService();
  const ctx = new ExecutionContext(mockSSH);
  // When SSH service is provided but no remoteDir, falls back to process.cwd
  t.is(ctx.getCwd(), process.cwd());
});

test('isSandboxAvailable returns true locally and false in SSH mode', (t) => {
  t.true(new ExecutionContext().isSandboxAvailable());
  t.false(new ExecutionContext(createMockSSHService()).isSandboxAvailable());
});

test('getOrCreateSandboxSession reuses an existing session', async (t) => {
  let createCount = 0;
  const session = createMockSandboxSession();

  const ctx = new ExecutionContext(undefined, undefined, {
    sandboxClientFactory: () => ({
      create: async () => {
        createCount += 1;
        return session as any;
      },
    }),
  });

  const first = await ctx.getOrCreateSandboxSession();
  const second = await ctx.getOrCreateSandboxSession();

  t.is(first, session);
  t.is(second, session);
  t.is(createCount, 1);
});

test('getOrCreateSandboxSession coalesces concurrent creation requests', async (t) => {
  let createCount = 0;
  const deferred = createDeferred<any>();
  const session = createMockSandboxSession();

  const ctx = new ExecutionContext(undefined, undefined, {
    sandboxClientFactory: () => ({
      create: async () => {
        createCount += 1;
        return deferred.promise;
      },
    }),
  });

  const firstPromise = ctx.getOrCreateSandboxSession();
  const secondPromise = ctx.getOrCreateSandboxSession();

  t.is(createCount, 1);

  deferred.resolve(session as any);

  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  t.is(first, session);
  t.is(second, session);
  t.is(createCount, 1);
});

test('closeSandboxSession is idempotent and clears the cache', async (t) => {
  let createCount = 0;
  let closeCount = 0;
  const session1 = createMockSandboxSession({
    close: async () => {
      closeCount += 1;
    },
  });
  const session2 = createMockSandboxSession();

  const ctx = new ExecutionContext(undefined, undefined, {
    sandboxClientFactory: () => ({
      create: async () => {
        createCount += 1;
        return (createCount === 1 ? session1 : session2) as any;
      },
    }),
  });

  const first = await ctx.getOrCreateSandboxSession();
  t.is(first, session1);

  await ctx.closeSandboxSession();
  await ctx.closeSandboxSession();

  const second = await ctx.getOrCreateSandboxSession();

  t.is(closeCount, 1);
  t.is(second, session2);
  t.is(createCount, 2);
});
