import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import CommandMessage from './CommandMessage.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE } from '../tools/tool-names.js';

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

test('CommandMessage renders apply_patch update_file with [PATCH] header and diff', async (t) => {
  const diff = ' context line\n-old line\n+new line\n context line';
  const props = {
    command: 'apply_patch update_file src/file.ts',
    toolName: TOOL_NAME_APPLY_PATCH,
    toolArgs: { path: 'src/file.ts', diff, type: 'update_file' },
    status: 'completed' as 'running' | 'pending' | 'completed' | 'failed',
    success: true,
    output: 'Updated src/file.ts',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('[PATCH]'), `Expected "[PATCH]" in output: ${output}`);
  t.true(output.includes('src/file.ts'), `Expected file path in output: ${output}`);
  t.true(output.includes('-old line'), `Expected removed line in output: ${output}`);
  t.true(output.includes('+new line'), `Expected added line in output: ${output}`);
});

test('CommandMessage renders apply_patch create_file with [CREATE FILE] header and diff', async (t) => {
  const diff = '+line 1\n+line 2';
  const props = {
    command: 'apply_patch create_file src/new.ts',
    toolName: TOOL_NAME_APPLY_PATCH,
    toolArgs: { path: 'src/new.ts', diff, type: 'create_file' },
    status: 'completed' as 'running' | 'pending' | 'completed' | 'failed',
    success: true,
    output: 'Created src/new.ts',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('[CREATE FILE]'), `Expected "[CREATE FILE]" in output: ${output}`);
  t.true(output.includes('src/new.ts'), `Expected file path in output: ${output}`);
  t.true(output.includes('+line 1'), `Expected added lines in output: ${output}`);
});

test('CommandMessage renders apply_patch with only output when hadApproval is true', async (t) => {
  const diff = ' context\n-old\n+new';
  const props = {
    command: 'apply_patch update_file src/file.ts',
    toolName: TOOL_NAME_APPLY_PATCH,
    toolArgs: { path: 'src/file.ts', diff, type: 'update_file' },
    status: 'completed' as 'running' | 'pending' | 'completed' | 'failed',
    success: true,
    output: 'Updated src/file.ts',
    hadApproval: true,
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.false(output.includes('[PATCH]'), `Expected no "[PATCH]" when hadApproval: ${output}`);
  t.true(output.includes('Updated src/file.ts'), `Expected output message: ${output}`);
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
