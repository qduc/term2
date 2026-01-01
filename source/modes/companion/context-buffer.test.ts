import test from 'ava';
import {ContextBuffer, type CommandEntry} from './context-buffer.js';

// Helper to create a test entry
function createEntry(
    command: string,
    output: string,
    exitCode = 0,
    timestamp = Date.now(),
): CommandEntry {
    return {
        command,
        output,
        exitCode,
        timestamp,
        outputLines: output.split('\n').length,
    };
}

test('stores commands with output', t => {
    const buffer = new ContextBuffer({maxSize: 1024, maxCommands: 5});

    buffer.addEntry(createEntry('ls -la', 'file1.txt\nfile2.txt'));

    const entries = buffer.getLastN(1);
    t.is(entries[0]?.command, 'ls -la');
    t.is(entries[0]?.output, 'file1.txt\nfile2.txt');
});

test('returns entries in most-recent-first order', t => {
    const buffer = new ContextBuffer({maxSize: 1024, maxCommands: 5});

    buffer.addEntry(createEntry('cmd1', 'out1', 0, 1));
    buffer.addEntry(createEntry('cmd2', 'out2', 0, 2));
    buffer.addEntry(createEntry('cmd3', 'out3', 0, 3));

    const entries = buffer.getLastN(3);
    t.is(entries[0]?.command, 'cmd3');
    t.is(entries[1]?.command, 'cmd2');
    t.is(entries[2]?.command, 'cmd1');
});

test('evicts oldest entries when maxCommands exceeded', t => {
    const buffer = new ContextBuffer({maxSize: 10000, maxCommands: 2});

    buffer.addEntry(createEntry('cmd1', 'out1', 0, 1));
    buffer.addEntry(createEntry('cmd2', 'out2', 0, 2));
    buffer.addEntry(createEntry('cmd3', 'out3', 0, 3));

    const entries = buffer.getLastN(10);
    t.is(entries.length, 2);
    t.is(entries[0]?.command, 'cmd3');
    t.is(entries[1]?.command, 'cmd2');
});

test('evicts entries when maxSize exceeded', t => {
    // Each entry is ~100 bytes (command + output + overhead)
    const buffer = new ContextBuffer({maxSize: 200, maxCommands: 10});

    buffer.addEntry(createEntry('cmd1', 'x'.repeat(80), 0, 1));
    buffer.addEntry(createEntry('cmd2', 'y'.repeat(80), 0, 2));
    buffer.addEntry(createEntry('cmd3', 'z'.repeat(80), 0, 3));

    // Should have evicted some entries due to size
    t.true(buffer.length <= 2);
});

test('getEntry returns entry by index', t => {
    const buffer = new ContextBuffer({maxSize: 1024, maxCommands: 5});

    buffer.addEntry(createEntry('cmd1', 'out1', 0, 1));
    buffer.addEntry(createEntry('cmd2', 'out2', 0, 2));

    const entry = buffer.getEntry(1);
    t.is(entry?.command, 'cmd1');
});

test('getEntry returns undefined for out of bounds index', t => {
    const buffer = new ContextBuffer({maxSize: 1024, maxCommands: 5});

    buffer.addEntry(createEntry('cmd1', 'out1'));

    t.is(buffer.getEntry(5), undefined);
});

test('search finds entries by command', t => {
    const buffer = new ContextBuffer({maxSize: 1024, maxCommands: 10});

    buffer.addEntry(createEntry('npm test', 'passed'));
    buffer.addEntry(createEntry('npm install', 'installed'));
    buffer.addEntry(createEntry('git status', 'clean'));

    const results = buffer.search('npm');
    t.is(results.length, 2);
    t.true(results.some(e => e.command === 'npm test'));
    t.true(results.some(e => e.command === 'npm install'));
});

test('search finds entries by output', t => {
    const buffer = new ContextBuffer({maxSize: 1024, maxCommands: 10});

    buffer.addEntry(createEntry('test1', 'error: file not found'));
    buffer.addEntry(createEntry('test2', 'success'));

    const results = buffer.search('error');
    t.is(results.length, 1);
    t.is(results[0]?.command, 'test1');
});

test('search is case insensitive', t => {
    const buffer = new ContextBuffer({maxSize: 1024, maxCommands: 10});

    buffer.addEntry(createEntry('NPM TEST', 'passed'));

    const results = buffer.search('npm');
    t.is(results.length, 1);
});

test('search limits results', t => {
    const buffer = new ContextBuffer({maxSize: 1024, maxCommands: 10});

    for (let i = 0; i < 10; i++) {
        buffer.addEntry(createEntry(`npm cmd${i}`, 'out'));
    }

    const results = buffer.search('npm', 3);
    t.is(results.length, 3);
});

test('getIndex generates lightweight command index', t => {
    const now = Date.now();
    const buffer = new ContextBuffer({maxSize: 1024, maxCommands: 10});

    buffer.addEntry(createEntry('npm test', 'FAIL: 2 tests failed', 1, now - 30000));
    buffer.addEntry(createEntry('git diff', '+new line', 0, now - 5000));

    const index = buffer.getIndex();

    // Note: entries are in most-recent-first order, so git diff is first
    t.is(index.length, 2);
    t.is(index[0]?.command, 'git diff');
    t.is(index[0]?.exitCode, 0);
    t.false(index[0]?.hasErrors);
    t.truthy(index[0]?.relativeTime);

    t.is(index[1]?.command, 'npm test');
    t.is(index[1]?.exitCode, 1);
    t.true(index[1]?.hasErrors);
});

test('getIndex detects errors from exit code', t => {
    const buffer = new ContextBuffer({maxSize: 1024, maxCommands: 10});

    buffer.addEntry(createEntry('cmd', 'no error keywords', 1));

    const index = buffer.getIndex();
    t.true(index[0]?.hasErrors);
});

test('getIndex detects errors from output patterns', t => {
    const buffer = new ContextBuffer({maxSize: 1024, maxCommands: 10});

    buffer.addEntry(createEntry('cmd', 'fatal: something went wrong', 0));

    const index = buffer.getIndex();
    t.true(index[0]?.hasErrors);
});

test('getIndex formats relative time correctly', t => {
    const now = Date.now();
    const buffer = new ContextBuffer({maxSize: 1024, maxCommands: 10});

    buffer.addEntry(createEntry('cmd1', 'out', 0, now - 120000)); // 2 minutes ago
    buffer.addEntry(createEntry('cmd2', 'out', 0, now - 5000)); // 5 seconds ago (most recent)

    const index = buffer.getIndex();

    // Note: entries are in most-recent-first order
    // cmd2 is most recent (5s ago), cmd1 is older (2m ago)
    t.regex(index[0]?.relativeTime ?? '', /\d+s ago/);
    t.regex(index[1]?.relativeTime ?? '', /\d+m ago/);
});

test('clear removes all entries', t => {
    const buffer = new ContextBuffer({maxSize: 1024, maxCommands: 10});

    buffer.addEntry(createEntry('cmd1', 'out1'));
    buffer.addEntry(createEntry('cmd2', 'out2'));

    buffer.clear();

    t.is(buffer.length, 0);
    t.is(buffer.size, 0);
});

test('length returns correct count', t => {
    const buffer = new ContextBuffer({maxSize: 1024, maxCommands: 10});

    t.is(buffer.length, 0);

    buffer.addEntry(createEntry('cmd1', 'out1'));
    t.is(buffer.length, 1);

    buffer.addEntry(createEntry('cmd2', 'out2'));
    t.is(buffer.length, 2);
});

test('size tracks buffer size in bytes', t => {
    const buffer = new ContextBuffer({maxSize: 10000, maxCommands: 10});

    t.is(buffer.size, 0);

    buffer.addEntry(createEntry('cmd', 'output'));
    t.true(buffer.size > 0);
});
