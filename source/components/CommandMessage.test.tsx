import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import CommandMessage from './CommandMessage.js';

test('CommandMessage does not duplicate parameters when they are already in command string', async t => {
    const props = {
        command: 'shell: ls -la',
        toolName: 'shell',
        toolArgs: {command: 'ls -la'},
        status: 'running' as 'running' | 'pending' | 'completed' | 'failed',
    };

    const {lastFrame} = render(<CommandMessage {...props} />);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const output = lastFrame() ?? '';

    // The bug would cause "ls -la" to appear twice
    // e.g. "$ shell: ls -la ls -la"

    // Count occurrences of "ls -la"
    const count = (output.match(/ls -la/g) || []).length;

    // It should only appear once in the command line
    t.is(count, 1, `Expected "ls -la" to appear once, but found ${count}. Output: ${output}`);
});

test('CommandMessage still shows arguments for unknown tools where command is just toolName', async t => {
    const props = {
        command: 'unknown_tool',
        toolName: 'unknown_tool',
        toolArgs: {foo: 'bar'},
        status: 'running' as 'running' | 'pending' | 'completed' | 'failed',
    };

    const {lastFrame} = render(<CommandMessage {...props} />);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const output = lastFrame() ?? '';

    t.true(output.includes('unknown_tool'));
    t.true(output.includes('foo=bar'));
});
