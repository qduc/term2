import test from 'ava';
import {EventEmitter} from 'events';
import {SSHService, SSHConfig} from './ssh-service.js';

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

test('connect: establishes connection successfully', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);

    await service.connect();

    t.true(mockClient.connectCalled);
    t.true(service.isConnected());
});

test('connect: rejects on connection error', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);

    // Override connect to emit error instead of ready
    mockClient.connect = function() {
        mockClient.connectCalled = true;
        setImmediate(() => mockClient.emit('error', new Error('Connection refused')));
    };

    await t.throwsAsync(service.connect(), {message: 'Connection refused'});
    t.false(service.isConnected());
});

test('disconnect: closes connection', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);

    await service.connect();
    t.true(service.isConnected());

    await service.disconnect();
    t.true(mockClient.endCalled);
    t.false(service.isConnected());
});

test('disconnect: handles already disconnected', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);

    // Disconnect without connecting first
    await service.disconnect();
    t.false(mockClient.endCalled);
    t.false(service.isConnected());
});

test('isConnected: returns false initially', t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);

    t.false(service.isConnected());
});

test('isConnected: returns false after end event', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);

    await service.connect();
    t.true(service.isConnected());

    // Simulate connection end from server
    mockClient.emit('end');
    t.false(service.isConnected());
});

// --- Execute Command Tests ---

test('executeCommand: throws when not connected', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);

    await t.throwsAsync(service.executeCommand('ls'), {
        message: 'SSH client not connected',
    });
});

test('executeCommand: executes command and returns result', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);
    await service.connect();

    const resultPromise = service.executeCommand('ls -la');

    // Wait for exec to be called
    await new Promise(resolve => setImmediate(resolve));

    t.is(mockClient.lastExecCommand, 'ls -la');

    // Simulate command output
    mockClient.mockStream!.simulateOutput('file1.txt\nfile2.txt\n', '', 0);

    const result = await resultPromise;
    t.is(result.stdout, 'file1.txt\nfile2.txt\n');
    t.is(result.stderr, '');
    t.is(result.exitCode, 0);
    t.false(result.timedOut);
});

test('executeCommand: captures stderr', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);
    await service.connect();

    const resultPromise = service.executeCommand('invalid-command');

    await new Promise(resolve => setImmediate(resolve));

    mockClient.mockStream!.simulateOutput('', 'command not found', 127);

    const result = await resultPromise;
    t.is(result.stdout, '');
    t.is(result.stderr, 'command not found');
    t.is(result.exitCode, 127);
});

test('executeCommand: handles both stdout and stderr', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);
    await service.connect();

    const resultPromise = service.executeCommand('mixed-output');

    await new Promise(resolve => setImmediate(resolve));

    mockClient.mockStream!.emit('data', Buffer.from('stdout line\n'));
    mockClient.mockStream!.stderr.emit('data', Buffer.from('stderr line\n'));
    mockClient.mockStream!.emit('close', 0);

    const result = await resultPromise;
    t.is(result.stdout, 'stdout line\n');
    t.is(result.stderr, 'stderr line\n');
    t.is(result.exitCode, 0);
});

test('executeCommand: prepends cd when cwd option provided', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);
    await service.connect();

    const resultPromise = service.executeCommand('ls', {cwd: '/home/user'});

    await new Promise(resolve => setImmediate(resolve));

    t.is(mockClient.lastExecCommand, 'cd "/home/user" && ls');

    mockClient.mockStream!.simulateOutput('', '', 0);
    await resultPromise;
});

test('executeCommand: rejects on exec error', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);
    await service.connect();

    // Override exec to return error
    mockClient.exec = function(_cmd: string, callback: (err: Error | null, stream: MockStream) => void) {
        setImmediate(() => callback(new Error('Exec failed'), null as any));
    };

    await t.throwsAsync(service.executeCommand('ls'), {message: 'Exec failed'});
});

// --- File Operations Tests ---

test('readFile: reads file content via cat', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);
    await service.connect();

    const resultPromise = service.readFile('/path/to/file.txt');

    await new Promise(resolve => setImmediate(resolve));

    t.is(mockClient.lastExecCommand, 'cat "/path/to/file.txt"');

    mockClient.mockStream!.simulateOutput('file content here', '', 0);

    const content = await resultPromise;
    t.is(content, 'file content here');
});

test('readFile: throws on failure', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);
    await service.connect();

    const resultPromise = service.readFile('/nonexistent.txt');

    await new Promise(resolve => setImmediate(resolve));

    mockClient.mockStream!.simulateOutput('', 'No such file or directory', 1);

    await t.throwsAsync(resultPromise, {
        message: /Failed to read file.*No such file or directory/,
    });
});

test('writeFile: writes content via heredoc', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);
    await service.connect();

    const resultPromise = service.writeFile('/path/to/file.txt', 'new content');

    await new Promise(resolve => setImmediate(resolve));

    // Should use heredoc with unique delimiter
    t.true(mockClient.lastExecCommand!.startsWith('cat > "/path/to/file.txt" << \'TERM2_EOF_'));
    t.true(mockClient.lastExecCommand!.includes('new content'));

    mockClient.mockStream!.simulateOutput('', '', 0);
    await resultPromise;
    t.pass();
});

test('writeFile: throws on failure', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);
    await service.connect();

    const resultPromise = service.writeFile('/readonly/file.txt', 'content');

    await new Promise(resolve => setImmediate(resolve));

    mockClient.mockStream!.simulateOutput('', 'Permission denied', 1);

    await t.throwsAsync(resultPromise, {
        message: /Failed to write file.*Permission denied/,
    });
});

test('writeFile: throws if content contains delimiter', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);
    await service.connect();

    // Create content that would conflict with delimiter
    // The delimiter is TERM2_EOF_ + timestamp, so we need to mock Date.now
    const originalDateNow = Date.now;
    Date.now = () => 12345;

    try {
        await t.throwsAsync(
            service.writeFile('/path/file.txt', 'content with TERM2_EOF_12345 in it'),
            {message: 'Content contains internal delimiter'},
        );
    } finally {
        Date.now = originalDateNow;
    }
});

test('mkdir: creates directory', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);
    await service.connect();

    const resultPromise = service.mkdir('/new/dir');

    await new Promise(resolve => setImmediate(resolve));

    t.is(mockClient.lastExecCommand, 'mkdir  "/new/dir"');

    mockClient.mockStream!.simulateOutput('', '', 0);
    await resultPromise;
    t.pass();
});

test('mkdir: creates directory recursively', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);
    await service.connect();

    const resultPromise = service.mkdir('/new/nested/dir', {recursive: true});

    await new Promise(resolve => setImmediate(resolve));

    t.is(mockClient.lastExecCommand, 'mkdir -p "/new/nested/dir"');

    mockClient.mockStream!.simulateOutput('', '', 0);
    await resultPromise;
    t.pass();
});

test('mkdir: throws on failure', async t => {
    const mockClient = new MockClient();
    const service = new SSHService(testConfig, mockClient as any);
    await service.connect();

    const resultPromise = service.mkdir('/readonly/dir');

    await new Promise(resolve => setImmediate(resolve));

    mockClient.mockStream!.simulateOutput('', 'Permission denied', 1);

    await t.throwsAsync(resultPromise, {
        message: /Failed to mkdir.*Permission denied/,
    });
});
