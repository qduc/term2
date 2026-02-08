import test from 'ava';
import { ExecutionContext } from './execution-context.js';
import { ISSHService } from './service-interfaces.js';

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
