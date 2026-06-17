import { describe, it, expect } from 'vitest';
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

it('isRemote returns false when no SSH service provided', () => {
  const ctx = new ExecutionContext();
  expect(ctx.isRemote()).toBe(false);
});

it('isRemote returns true when SSH service provided', () => {
  const mockSSH = createMockSSHService();
  const ctx = new ExecutionContext(mockSSH, '/remote/path');
  expect(ctx.isRemote()).toBe(true);
});

it('getSSHService returns undefined when no SSH service', () => {
  const ctx = new ExecutionContext();
  expect(ctx.getSSHService()).toBeUndefined();
});

it('getSSHService returns SSH service when provided', () => {
  const mockSSH = createMockSSHService();
  const ctx = new ExecutionContext(mockSSH, '/remote/path');
  expect(ctx.getSSHService()).toBe(mockSSH);
});

it('getCwd returns process.cwd when not remote', () => {
  const ctx = new ExecutionContext();
  expect(ctx.getCwd()).toBe(process.cwd());
});

it('getCwd returns remoteDir when in remote mode', () => {
  const mockSSH = createMockSSHService();
  const remoteDir = '/home/user/project';
  const ctx = new ExecutionContext(mockSSH, remoteDir);
  expect(ctx.getCwd()).toBe(remoteDir);
});

it('getCwd returns process.cwd when remote but no remoteDir', () => {
  const mockSSH = createMockSSHService();
  const ctx = new ExecutionContext(mockSSH);
  // When SSH service is provided but no remoteDir, falls back to process.cwd
  expect(ctx.getCwd()).toBe(process.cwd());
});
