import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { SSHService, SSHConfig } from './ssh-service.js';

// Mock stream that mimics ssh2 exec stream
class MockStream extends EventEmitter {
  stderr = new EventEmitter();

  simulateOutput(stdout: string, stderr: string, exitCode: number) {
    if (stdout) {
      this.emit('data', Buffer.from(stdout));
    }
    if (stderr) {
      this.stderr.emit('data', Buffer.from(stderr));
    }
    this.emit('close', exitCode);
  }
}

// Mock Client that mimics ssh2 Client
class MockClient extends EventEmitter {
  connectCalled = false;
  endCalled = false;
  lastExecCommand: string | null = null;
  execCallback: ((err: Error | null, stream: MockStream) => void) | null = null;
  mockStream: MockStream | null = null;

  connect(_config: SSHConfig) {
    this.connectCalled = true;
    // Simulate async ready event
    setImmediate(() => this.emit('ready'));
  }

  end() {
    this.endCalled = true;
    this.emit('end');
  }

  exec(command: string, callback: (err: Error | null, stream: MockStream) => void) {
    this.lastExecCommand = command;
    this.execCallback = callback;
    this.mockStream = new MockStream();
    // Simulate async callback
    setImmediate(() => callback(null, this.mockStream!));
  }

  simulateExecError(err: Error) {
    if (this.execCallback) {
      this.execCallback(err, null as any);
    }
  }

  simulateConnectionError(err: Error) {
    this.emit('error', err);
  }
}

const testConfig: SSHConfig = {
  host: 'test.example.com',
  port: 22,
  username: 'testuser',
};

// --- Connection Tests ---

it('connect: establishes connection successfully', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);

  await service.connect();

  expect(mockClient.connectCalled).toBe(true);
  expect(service.isConnected()).toBe(true);
});

it('connect: rejects on connection error', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);

  // Override connect to emit error instead of ready
  mockClient.connect = function () {
    mockClient.connectCalled = true;
    setImmediate(() => mockClient.emit('error', new Error('Connection refused')));
  };

  await await expect(service.connect()).rejects.toThrow('Connection refused');
  expect(service.isConnected()).toBe(false);
});

it('disconnect: closes connection', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);

  await service.connect();
  expect(service.isConnected()).toBe(true);

  await service.disconnect();
  expect(mockClient.endCalled).toBe(true);
  expect(service.isConnected()).toBe(false);
});

it('disconnect: handles already disconnected', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);

  // Disconnect without connecting first
  await service.disconnect();
  expect(mockClient.endCalled).toBe(false);
  expect(service.isConnected()).toBe(false);
});

it('isConnected: returns false initially', () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);

  expect(service.isConnected()).toBe(false);
});

it('isConnected: returns false after end event', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);

  await service.connect();
  expect(service.isConnected()).toBe(true);

  // Simulate connection end from server
  mockClient.emit('end');
  expect(service.isConnected()).toBe(false);
});

// --- Execute Command Tests ---

it('executeCommand: throws when not connected', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);

  await expect(service.executeCommand('ls')).rejects.toThrow('SSH client not connected');
});

it('executeCommand: executes command and returns result', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.executeCommand('ls -la');

  // Wait for exec to be called
  await new Promise((resolve) => setImmediate(resolve));

  expect(mockClient.lastExecCommand).toBe('ls -la');

  // Simulate command output
  mockClient.mockStream!.simulateOutput('file1.txt\nfile2.txt\n', '', 0);

  const result = await resultPromise;
  expect(result.stdout).toBe('file1.txt\nfile2.txt\n');
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  expect(result.timedOut).toBe(false);
});

it('executeCommand: captures stderr', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.executeCommand('invalid-command');

  await new Promise((resolve) => setImmediate(resolve));

  mockClient.mockStream!.simulateOutput('', 'command not found', 127);

  const result = await resultPromise;
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('command not found');
  expect(result.exitCode).toBe(127);
});

it('executeCommand: handles both stdout and stderr', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.executeCommand('mixed-output');

  await new Promise((resolve) => setImmediate(resolve));

  mockClient.mockStream!.emit('data', Buffer.from('stdout line\n'));
  mockClient.mockStream!.stderr.emit('data', Buffer.from('stderr line\n'));
  mockClient.mockStream!.emit('close', 0);

  const result = await resultPromise;
  expect(result.stdout).toBe('stdout line\n');
  expect(result.stderr).toBe('stderr line\n');
  expect(result.exitCode).toBe(0);
});

it('executeCommand: prepends cd when cwd option provided', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.executeCommand('ls', { cwd: '/home/user' });

  await new Promise((resolve) => setImmediate(resolve));

  expect(mockClient.lastExecCommand).toBe('cd "/home/user" && ls');

  mockClient.mockStream!.simulateOutput('', '', 0);
  await resultPromise;
});

it('executeCommand: rejects on exec error', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  // Override exec to return error
  mockClient.exec = function (_cmd: string, callback: (err: Error | null, stream: MockStream) => void) {
    setImmediate(() => callback(new Error('Exec failed'), null as any));
  };

  await await expect(service.executeCommand('ls')).rejects.toThrow('Exec failed');
});

// --- File Operations Tests ---

it('readFile: reads file content via cat', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.readFile('/path/to/file.txt');

  await new Promise((resolve) => setImmediate(resolve));

  expect(mockClient.lastExecCommand).toBe('cat "/path/to/file.txt"');

  mockClient.mockStream!.simulateOutput('file content here', '', 0);

  const content = await resultPromise;
  expect(content).toBe('file content here');
});

it('readFile: throws on failure', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.readFile('/nonexistent.txt');

  await new Promise((resolve) => setImmediate(resolve));

  mockClient.mockStream!.simulateOutput('', 'No such file or directory', 1);

  await expect(resultPromise).rejects.toThrow(/Failed to read file.*No such file or directory/);
});

it('writeFile: writes content via heredoc', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.writeFile('/path/to/file.txt', 'new content');

  await new Promise((resolve) => setImmediate(resolve));

  // Should use heredoc with unique delimiter
  expect(mockClient.lastExecCommand!.startsWith('cat > "/path/to/file.txt" << \'TERM2_EOF_')).toBe(true);
  expect(mockClient.lastExecCommand!.includes('new content')).toBe(true);

  mockClient.mockStream!.simulateOutput('', '', 0);
  await resultPromise;
  expect(true).toBe(true);
});

it('writeFile: throws on failure', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.writeFile('/readonly/file.txt', 'content');

  await new Promise((resolve) => setImmediate(resolve));

  mockClient.mockStream!.simulateOutput('', 'Permission denied', 1);

  await expect(resultPromise).rejects.toThrow(/Failed to write file.*Permission denied/);
});

it('writeFile: throws if content contains delimiter', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  // Create content that would conflict with delimiter
  // The delimiter is TERM2_EOF_ + timestamp, so we need to mock Date.now
  const originalDateNow = Date.now;
  Date.now = () => 12345;

  try {
    await expect(service.writeFile('/path/file.txt', 'content with TERM2_EOF_12345 in it')).rejects.toThrow(
      'Content contains internal delimiter',
    );
  } finally {
    Date.now = originalDateNow;
  }
});

it('mkdir: creates directory', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.mkdir('/new/dir');

  await new Promise((resolve) => setImmediate(resolve));

  expect(mockClient.lastExecCommand ?? '').toMatch(/^mkdir\s+"\/new\/dir"$/);

  mockClient.mockStream!.simulateOutput('', '', 0);
  await resultPromise;
  expect(true).toBe(true);
});

it('mkdir: creates directory recursively', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.mkdir('/new/nested/dir', { recursive: true });

  await new Promise((resolve) => setImmediate(resolve));

  expect(mockClient.lastExecCommand ?? '').toMatch(/^mkdir\s+-p\s+"\/new\/nested\/dir"$/);

  mockClient.mockStream!.simulateOutput('', '', 0);
  await resultPromise;
  expect(true).toBe(true);
});

it('mkdir: throws on failure', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.mkdir('/readonly/dir');

  await new Promise((resolve) => setImmediate(resolve));

  mockClient.mockStream!.simulateOutput('', 'Permission denied', 1);

  await expect(resultPromise).rejects.toThrow(/Failed to mkdir.*Permission denied/);
});
