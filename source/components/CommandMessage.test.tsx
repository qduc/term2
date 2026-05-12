import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import CommandMessage from './CommandMessage.js';
import { TOOL_NAME_CREATE_FILE } from '../tools/tool-names.js';

test('CommandMessage does not duplicate parameters when they are already in command string', async (t) => {
  const props = {
    command: 'shell: ls -la',
    toolName: 'shell',
    toolArgs: { command: 'ls -la' },
    status: 'running' as 'running' | 'pending' | 'completed' | 'failed',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const output = lastFrame() ?? '';

  // The bug would cause "ls -la" to appear twice
  // e.g. "$ shell: ls -la ls -la"

  // Count occurrences of "ls -la"
  const count = (output.match(/ls -la/g) || []).length;

  // It should only appear once in the command line
  t.is(count, 1, `Expected "ls -la" to appear once, but found ${count}. Output: ${output}`);
});

test('CommandMessage still shows arguments for unknown tools where command is just toolName', async (t) => {
  const props = {
    command: 'unknown_tool',
    toolName: 'unknown_tool',
    toolArgs: { foo: 'bar' },
    status: 'running' as 'running' | 'pending' | 'completed' | 'failed',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const output = lastFrame() ?? '';

  t.true(output.includes('unknown_tool'));
  t.true(output.includes('foo=bar'));
});

test('CommandMessage renders create_file with [CREATE] header and file path', async (t) => {
  const props = {
    command: 'create_file "src/new-file.ts"',
    toolName: TOOL_NAME_CREATE_FILE,
    toolArgs: { path: 'src/new-file.ts', content: 'console.log("hello");\n' },
    status: 'completed' as 'running' | 'pending' | 'completed' | 'failed',
    success: true,
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('[CREATE]'), `Expected "[CREATE]" in output: ${output}`);
  t.true(output.includes('src/new-file.ts'), `Expected file path in output: ${output}`);
});

test('CommandMessage renders create_file content as diff with + prefix', async (t) => {
  const props = {
    command: 'create_file "src/new-file.ts"',
    toolName: TOOL_NAME_CREATE_FILE,
    toolArgs: { path: 'src/new-file.ts', content: 'line 1\nline 2\n' },
    status: 'completed' as 'running' | 'pending' | 'completed' | 'failed',
    success: true,
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('+line 1'), `Expected "+line 1" in output: ${output}`);
  t.true(output.includes('+line 2'), `Expected "+line 2" in output: ${output}`);
});

test('CommandMessage renders create_file failure in red', async (t) => {
  const props = {
    command: 'create_file "src/existing.ts"',
    toolName: TOOL_NAME_CREATE_FILE,
    toolArgs: { path: 'src/existing.ts', content: 'content' },
    status: 'completed' as 'running' | 'pending' | 'completed' | 'failed',
    success: false,
    output: 'Error: File already exists at src/existing.ts.',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('[CREATE]'), `Expected "[CREATE]" in output: ${output}`);
  t.true(output.includes('Error'), `Expected error message in output: ${output}`);
});
