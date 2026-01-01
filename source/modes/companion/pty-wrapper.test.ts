import test from 'ava';
import {PTYWrapper} from './pty-wrapper.js';

/**
 * Tests for PTY wrapper.
 * These tests verify that the PTY wrapper correctly spawns shells and handles I/O.
 */

// Mock PTY implementation for testing
class MockPTY {
private dataHandlers: Array<(data: string) => void> = [];
private exitHandlers: Array<(event: {exitCode: number}) => void> = [];
public rows = 24;
public cols = 80;

onData(handler: (data: string) => void): void {
this.dataHandlers.push(handler);
}

onExit(handler: (event: {exitCode: number}) => void): void {
this.exitHandlers.push(handler);
}

write(data: string): void {
// Simulate echo
this.simulateOutput(data);
}

resize(cols: number, rows: number): void {
this.cols = cols;
this.rows = rows;
}

kill(): void {
// Simulate exit
this.simulateExit(0);
}

// Test helpers
simulateOutput(data: string): void {
this.dataHandlers.forEach(handler => handler(data));
}

simulateExit(exitCode: number): void {
this.exitHandlers.forEach(handler => handler({exitCode}));
}
}

type FactoryType = (shell: string, args: string[], options: any) => any;

function createMockPtyFactory(): FactoryType & {
lastSpawnedShell?: string;
lastSpawnedArgs?: string[];
lastSpawnedOptions?: any;
} {
const factory: any = (shell: string, args: string[], options: any) => {
factory.lastSpawnedShell = shell;
factory.lastSpawnedArgs = args;
factory.lastSpawnedOptions = options;
return new MockPTY();
};

return factory;
}

test('PTYWrapper spawns shell with correct environment', t => {
const mockFactory = createMockPtyFactory();
const wrapper = new PTYWrapper({
ptyFactory: mockFactory,
shell: '/bin/bash',
});

wrapper.start();

t.is(mockFactory.lastSpawnedShell, '/bin/bash');
t.truthy(mockFactory.lastSpawnedOptions);
t.is(mockFactory.lastSpawnedOptions.name, 'xterm-256color');
});

test('PTYWrapper uses SHELL environment variable by default', t => {
const originalShell = process.env.SHELL;
process.env.SHELL = '/bin/zsh';

const mockFactory = createMockPtyFactory();
const wrapper = new PTYWrapper({ptyFactory: mockFactory});

wrapper.start();

t.is(mockFactory.lastSpawnedShell, '/bin/zsh');

// Restore
if (originalShell) {
process.env.SHELL = originalShell;
}
});

test('PTYWrapper passes through output', t => {
const mockFactory = createMockPtyFactory();
const wrapper = new PTYWrapper({ptyFactory: mockFactory});
const received: string[] = [];

wrapper.onOutput(data => {
received.push(data);
});

const pty = wrapper.start();
(pty as any as MockPTY).simulateOutput('$ ls\nfile1.txt\nfile2.txt\n');

t.deepEqual(received, ['$ ls\nfile1.txt\nfile2.txt\n']);
});

test('PTYWrapper handles resize', t => {
const mockFactory = createMockPtyFactory();
const wrapper = new PTYWrapper({ptyFactory: mockFactory});

const pty = wrapper.start() as any as MockPTY;
wrapper.resize(120, 40);

t.is(pty.cols, 120);
t.is(pty.rows, 40);
});

test('PTYWrapper can write to PTY', t => {
const mockFactory = createMockPtyFactory();
const wrapper = new PTYWrapper({ptyFactory: mockFactory});
const received: string[] = [];

wrapper.onOutput(data => {
received.push(data);
});

wrapper.start();
wrapper.write('echo test\r');

t.true(received.length > 0);
t.is(received[0], 'echo test\r');
});
