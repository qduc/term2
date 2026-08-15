import { it, expect, afterEach, vi } from 'vitest';
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

  simulateStreamError(err: Error) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }
}

// Mock Client that mimics ssh2 Client
class MockClient extends EventEmitter {
  connectCalled = false;
  connectCallCount = 0;
  endCalled = false;
  lastExecCommand: string | null = null;
  execCallback: ((err: Error | null, stream: MockStream) => void) | null = null;
  mockStream: MockStream | null = null;

  connect(_config: SSHConfig) {
    this.connectCalled = true;
    this.connectCallCount += 1;
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

// Yield one event-loop turn so the mock's deferred exec callback runs.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// Fake-timer tests never leak real timers into later tests.
afterEach(() => {
  vi.useRealTimers();
});

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

  await expect(service.connect()).rejects.toThrow('Connection refused');
  expect(service.isConnected()).toBe(false);
});

it('connect: repeated connect while connected resolves without reconnecting', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);

  await service.connect();
  await service.connect();
  await service.connect();

  expect(service.isConnected()).toBe(true);
  expect(mockClient.connectCallCount).toBe(1);
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

it('isConnected: returns false after client close event', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);

  await service.connect();
  expect(service.isConnected()).toBe(true);

  // Simulate connection close from server
  mockClient.emit('close');
  expect(service.isConnected()).toBe(false);
});

// --- Execute Command Tests ---

it('executeCommand: throws when not connected', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);

  await expect(service.executeCommand('ls')).rejects.toThrow('SSH client not connected');
});

it('executeCommand: rejects with a typed not_connected outcome before any dispatch', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);

  await expect(service.executeCommand('ls')).rejects.toMatchObject({
    name: 'SSHTransportError',
    kind: 'not_connected',
    remoteEffect: 'none',
  });
  expect(mockClient.lastExecCommand).toBeNull();
});

it('executeCommand: executes command and returns result', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.executeCommand('ls -la');

  // Wait for exec to be called
  await tick();

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

  await tick();

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

  await tick();

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

  await tick();

  expect(mockClient.lastExecCommand).toBe("cd '/home/user' && ls");

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

  await expect(service.executeCommand('ls')).rejects.toThrow('Exec failed');
});

it('executeCommand: rejects with a typed exec_failed outcome on dispatch failure', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  mockClient.exec = function (_cmd: string, callback: (err: Error | null, stream: MockStream) => void) {
    setImmediate(() => callback(new Error('Exec failed'), null as any));
  };

  await expect(service.executeCommand('ls')).rejects.toMatchObject({
    name: 'SSHTransportError',
    kind: 'exec_failed',
    remoteEffect: 'unknown',
  });
});

// --- File Operations Tests ---

it('readFile: reads file content via cat', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.readFile('/path/to/file.txt');

  await tick();

  expect(mockClient.lastExecCommand).toBe("cat '/path/to/file.txt'");

  mockClient.mockStream!.simulateOutput('file content here', '', 0);

  const content = await resultPromise;
  expect(content).toBe('file content here');
});

it('readFile: throws on failure', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.readFile('/nonexistent.txt');

  await tick();

  mockClient.mockStream!.simulateOutput('', 'No such file or directory', 1);

  await expect(resultPromise).rejects.toThrow(/Failed to read file.*No such file or directory/);
});

it('writeFile: writes content via heredoc', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.writeFile('/path/to/file.txt', 'new content');

  await tick();

  // Should use heredoc with unique delimiter
  expect(mockClient.lastExecCommand!.startsWith("cat > '/path/to/file.txt' << 'TERM2_EOF_")).toBe(true);
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

  await tick();

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

  await tick();

  expect(mockClient.lastExecCommand ?? '').toMatch(/^mkdir\s+'\/new\/dir'$/);

  mockClient.mockStream!.simulateOutput('', '', 0);
  await resultPromise;
  expect(true).toBe(true);
});

it('mkdir: creates directory recursively', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.mkdir('/new/nested/dir', { recursive: true });

  await tick();

  expect(mockClient.lastExecCommand ?? '').toMatch(/^mkdir\s+-p\s+'\/new\/nested\/dir'$/);

  mockClient.mockStream!.simulateOutput('', '', 0);
  await resultPromise;
  expect(true).toBe(true);
});

it('mkdir: throws on failure', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.mkdir('/readonly/dir');

  await tick();

  mockClient.mockStream!.simulateOutput('', 'Permission denied', 1);

  await expect(resultPromise).rejects.toThrow(/Failed to mkdir.*Permission denied/);
});

// --- Contract 06: In-Flight Transport Drop Settlement (C6.1 / C6.3) ---
// Every in-flight executeCommand promise must settle promptly with a typed
// transport outcome when the connection drops after dispatch. Remote effect is
// ambiguous in every case: the remote process may have completed, partially
// completed, or be orphaned, so the outcome must not invite a blind replay.

it('executeCommand: in-flight connection error rejects the pending command rather than hanging indefinitely', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.executeCommand('long-running-cmd');
  await tick();

  let settled = false;
  let error: unknown = null;
  resultPromise.then(
    () => {
      settled = true;
    },
    (err) => {
      settled = true;
      error = err;
    },
  );

  // Simulate network drop/connection error while command is in flight
  mockClient.simulateConnectionError(new Error('Connection reset by peer'));
  await tick();

  // Safety invariant: in-flight command must reject with a typed transport
  // outcome rather than hanging forever, and must not claim replay safety.
  expect(settled).toBe(true);
  expect(error).toMatchObject({ name: 'SSHTransportError', kind: 'connection_error', remoteEffect: 'unknown' });
});

it('executeCommand: in-flight connection end rejects the pending command rather than hanging indefinitely', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.executeCommand('long-running-cmd');
  await tick();

  let settled = false;
  let error: unknown = null;
  resultPromise.then(
    () => {
      settled = true;
    },
    (err) => {
      settled = true;
      error = err;
    },
  );

  // Simulate server ending connection while command is in flight
  mockClient.emit('end');
  await tick();

  expect(settled).toBe(true);
  expect(error).toMatchObject({ name: 'SSHTransportError', kind: 'connection_end', remoteEffect: 'unknown' });
});

it('executeCommand: in-flight client close rejects the pending command rather than hanging indefinitely', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.executeCommand('long-running-cmd');
  await tick();

  let settled = false;
  let error: unknown = null;
  resultPromise.then(
    () => {
      settled = true;
    },
    (err) => {
      settled = true;
      error = err;
    },
  );

  // Simulate server/socket close event while command is in flight
  mockClient.emit('close');
  await tick();

  expect(settled).toBe(true);
  expect(error).toMatchObject({ name: 'SSHTransportError', kind: 'connection_close', remoteEffect: 'unknown' });
});

it('executeCommand: in-flight stream channel error rejects the pending command rather than hanging indefinitely', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.executeCommand('long-running-cmd');
  await tick();

  let settled = false;
  let error: unknown = null;
  resultPromise.then(
    () => {
      settled = true;
    },
    (err) => {
      settled = true;
      error = err;
    },
  );

  // Simulate stream-level error event without letting EventEmitter throw if 0 listeners
  mockClient.mockStream!.simulateStreamError(new Error('SSH stream channel failure'));
  await tick();

  expect(settled).toBe(true);
  expect(error).toMatchObject({ name: 'SSHTransportError', kind: 'channel_error', remoteEffect: 'unknown' });
});

it('executeCommand: explicit disconnect while command is in flight rejects the pending command', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.executeCommand('long-running-cmd');
  await tick();

  let settled = false;
  let error: unknown = null;
  resultPromise.then(
    () => {
      settled = true;
    },
    (err) => {
      settled = true;
      error = err;
    },
  );

  // Disconnect called while execution is pending
  await service.disconnect();
  await tick();

  expect(settled).toBe(true);
  expect(error).toMatchObject({ name: 'SSHTransportError', kind: 'explicit_disconnect', remoteEffect: 'unknown' });
});

it('executeCommand: a transport drop settles every command active at that moment', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const first = service.executeCommand('first');
  const second = service.executeCommand('second');
  await tick();

  mockClient.emit('close');

  await expect(first).rejects.toMatchObject({ kind: 'connection_close' });
  await expect(second).rejects.toMatchObject({ kind: 'connection_close' });
});

it('executeCommand: preserves partial output on a transport drop without claiming completeness', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const resultPromise = service.executeCommand('streams-then-drops');
  await tick();

  mockClient.mockStream!.emit('data', Buffer.from('partial stdout\n'));
  mockClient.mockStream!.stderr.emit('data', Buffer.from('partial stderr\n'));
  mockClient.emit('close');

  await expect(resultPromise).rejects.toMatchObject({
    name: 'SSHTransportError',
    kind: 'connection_close',
    remoteEffect: 'unknown',
    partialOutput: { stdout: 'partial stdout\n', stderr: 'partial stderr\n' },
  });
});

it('executeCommand: a command dispatched after reconnect settles only in its own connection era', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  // First era: a command dropped by connection close.
  const first = service.executeCommand('era-one');
  await tick();
  mockClient.emit('close');
  await expect(first).rejects.toMatchObject({ kind: 'connection_close' });

  // Reconnect on the same client; the previous era's listeners must not leak
  // into the new era.
  await service.connect();
  expect(service.isConnected()).toBe(true);

  const second = service.executeCommand('era-two');
  await tick();
  expect(mockClient.lastExecCommand).toBe('era-two');
  mockClient.mockStream!.simulateOutput('second era', '', 0);
  await expect(second).resolves.toMatchObject({ stdout: 'second era', exitCode: 0 });

  // A fresh drop settles only commands active in the new era.
  const third = service.executeCommand('era-three');
  await tick();
  mockClient.emit('end');
  await expect(third).rejects.toMatchObject({ kind: 'connection_end' });
});

// --- Contract 06: Opt-in timeoutMs (C6.3 containment boundary) ---
// Absent options preserve current behavior: no timer is armed, and the result
// keeps its full fidelity. With an explicit bound, the promise settles exactly
// at the boundary with a typed outcome; legitimate slow work is never touched
// without an explicit opt-in.

it('executeCommand: rejects with a typed timeout outcome when timeoutMs elapses', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  vi.useFakeTimers();
  try {
    const resultPromise = service.executeCommand('slow-cmd', { timeoutMs: 100 });

    vi.advanceTimersByTime(100);

    await expect(resultPromise).rejects.toMatchObject({
      name: 'SSHTransportError',
      kind: 'timeout',
      remoteEffect: 'unknown',
    });
  } finally {
    vi.useRealTimers();
  }
});

it('executeCommand: timeout settles exactly at timeoutMs and never before', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  vi.useFakeTimers();
  try {
    let settled = false;
    const resultPromise = service.executeCommand('slow-cmd', { timeoutMs: 100 });
    resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    vi.advanceTimersByTime(99);
    expect(settled).toBe(false);

    vi.advanceTimersByTime(1);
    await expect(resultPromise).rejects.toMatchObject({ kind: 'timeout' });
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('executeCommand: resolves normally when the command completes before timeoutMs', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  vi.useFakeTimers();
  try {
    const resultPromise = service.executeCommand('fast-cmd', { timeoutMs: 10_000 });

    // Drive the mock's exec callback manually: its setImmediate is faked here.
    mockClient.execCallback!(null, mockClient.mockStream!);
    mockClient.mockStream!.simulateOutput('done', '', 0);

    await expect(resultPromise).resolves.toMatchObject({ stdout: 'done', exitCode: 0, timedOut: false });

    // Advancing far past the deadline must not disturb the settled result.
    vi.advanceTimersByTime(10_000);
  } finally {
    vi.useRealTimers();
  }
});

// --- Contract 06: Opt-in AbortSignal (C6.3 cancellation boundary) ---

it('executeCommand: rejects with a typed aborted outcome when the caller aborts mid-flight', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const controller = new AbortController();
  const resultPromise = service.executeCommand('long-running-cmd', { signal: controller.signal });
  await tick();

  controller.abort(new Error('user cancelled'));

  await expect(resultPromise).rejects.toMatchObject({
    name: 'SSHTransportError',
    kind: 'aborted',
    remoteEffect: 'unknown',
  });
});

it('executeCommand: rejects before dispatch when the signal is already aborted', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const controller = new AbortController();
  controller.abort();

  await expect(service.executeCommand('ls', { signal: controller.signal })).rejects.toMatchObject({
    name: 'SSHTransportError',
    kind: 'aborted',
    remoteEffect: 'none',
  });
  expect(mockClient.lastExecCommand).toBeNull();
});

it('executeCommand: an abort after settlement leaves the resolved result intact', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const controller = new AbortController();
  const resultPromise = service.executeCommand('ls', { signal: controller.signal });
  await tick();

  mockClient.mockStream!.simulateOutput('done', '', 0);
  await expect(resultPromise).resolves.toMatchObject({ stdout: 'done', exitCode: 0 });

  // Aborting after completion must not reject or mutate the settled result.
  controller.abort();
  await expect(resultPromise).resolves.toMatchObject({ stdout: 'done', exitCode: 0 });
});

// --- Contract 06: Shell Input Safety / Metacharacter Escaping (C6.4) ---
// Paths and cwd are strictly data. Hostile strings appear only as quoted test
// data here; every assertion pins the canonical POSIX single-quote encoding.

it('executeCommand: encodes cwd using canonical POSIX single-quote escaping', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const complexCwd = 'dir with "double" and \'single\' and $(whoami); rm -rf /';
  const resultPromise = service.executeCommand('ls', { cwd: complexCwd });
  await tick();

  // Invariant C6.4: cwd must be encoded using canonical POSIX single-quote escaping
  expect(mockClient.lastExecCommand).toBe(
    "cd 'dir with \"double\" and '\\''single'\\'' and $(whoami); rm -rf /' && ls",
  );
  mockClient.mockStream!.simulateOutput('', '', 0);
  await resultPromise;
});

it('readFile: encodes path using canonical POSIX single-quote escaping', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const complexPath = 'path with "double" and \'single\' and $(whoami); rm -rf /';
  const resultPromise = service.readFile(complexPath);
  await tick();

  // Invariant C6.4: file path must be encoded using canonical POSIX single-quote escaping
  expect(mockClient.lastExecCommand).toBe("cat 'path with \"double\" and '\\''single'\\'' and $(whoami); rm -rf /'");
  mockClient.mockStream!.simulateOutput('file contents', '', 0);
  await resultPromise;
});

it('writeFile: encodes path using canonical POSIX single-quote escaping', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const complexPath = 'path with "double" and \'single\' and $(whoami); rm -rf /';
  const originalDateNow = Date.now;
  Date.now = () => 123456789;

  try {
    const resultPromise = service.writeFile(complexPath, 'hello world');
    await tick();

    // Invariant C6.4: write target path must be encoded using canonical POSIX single-quote escaping with fixed delimiter
    expect(mockClient.lastExecCommand).toBe(
      "cat > 'path with \"double\" and '\\''single'\\'' and $(whoami); rm -rf /' << 'TERM2_EOF_123456789'\nhello world\nTERM2_EOF_123456789",
    );
    mockClient.mockStream!.simulateOutput('', '', 0);
    await resultPromise;
  } finally {
    Date.now = originalDateNow;
  }
});

it('mkdir: encodes directory path using canonical POSIX single-quote escaping', async () => {
  const mockClient = new MockClient();
  const service = new SSHService(testConfig, mockClient as any);
  await service.connect();

  const complexDir = 'dir with "double" and \'single\' and $(whoami); rm -rf /';
  const resultPromise = service.mkdir(complexDir, { recursive: true });
  await tick();

  // Invariant C6.4: mkdir path must be encoded using canonical POSIX single-quote escaping
  expect(mockClient.lastExecCommand).toBe(
    "mkdir -p 'dir with \"double\" and '\\''single'\\'' and $(whoami); rm -rf /'",
  );
  mockClient.mockStream!.simulateOutput('', '', 0);
  await resultPromise;
});
