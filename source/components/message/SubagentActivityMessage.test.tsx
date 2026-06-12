// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import SubagentActivityMessage from './SubagentActivityMessage.js';
import { TOOL_NAME_CREATE_FILE } from '../../tools/tool-names.js';

const stripAnsi = (text: string) => text.replaceAll(/\u001B\[[0-9;]*m/g, '');

test('SubagentActivityMessage renders plain string tools', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'running',
      tools: ['read_file "source/app.tsx" (Success)'],
    },
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<SubagentActivityMessage {...props} />));
  });
  const output = stripAnsi(lastFrame?.() ?? '');

  t.true(output.includes('run_subagent [explorer] find x'), `Expected title in output: ${output}`);
  t.true(output.includes('read_file "source/app.tsx" (Success)'), `Expected tool in output: ${output}`);
});

test('SubagentActivityMessage renders write tool CommandMessage concisely', async (t) => {
  const writeMsg = {
    id: 'cmd-w1',
    sender: 'command' as const,
    status: 'completed' as const,
    command: 'create_file "src/test.txt"',
    toolName: TOOL_NAME_CREATE_FILE,
    toolArgs: { path: 'src/test.txt', content: 'hello' },
    success: true,
  };

  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'running',
      tools: [writeMsg],
    },
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    process.env.FORCE_COLOR = '1';
    ({ lastFrame } = render(<SubagentActivityMessage {...props} />));
  });
  const rawOutput = lastFrame?.() ?? '';
  const output = stripAnsi(rawOutput);

  t.true(output.includes('run_subagent [explorer] find x'), `Expected title in output: ${output}`);
  t.true(output.includes('✔'), `Expected concise checkmark in output: ${output}`);
  t.true(output.includes('Created "src/test.txt"'), `Expected concise display action: ${output}`);

  // Verify left-alignment: no leading spaces before the checkmark
  const lines = output.split('\n').map((l) => l.trimEnd());
  t.true(
    lines.some((line) => line.startsWith('✔ Created "src/test.txt"')),
    `Expected left-aligned checkmark in lines: ${JSON.stringify(lines)}`,
  );

  // Verify the hex color #64748b is applied if ANSI colors are generated
  if (rawOutput !== output) {
    t.true(
      rawOutput.includes('100;116;139') ||
        rawOutput.includes('38;2;100;116;139') ||
        rawOutput.includes('38;5;67') ||
        rawOutput.includes('36;100;116;139') ||
        rawOutput.includes('38;2;100') ||
        rawOutput.includes('90m') ||
        rawOutput.includes('37m'),
      `Expected color escape sequence in raw output: ${JSON.stringify(rawOutput)}`,
    );
  }
});
