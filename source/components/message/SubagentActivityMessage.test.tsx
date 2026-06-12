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
    ({ lastFrame } = render(<SubagentActivityMessage {...props} />));
  });
  const output = stripAnsi(lastFrame?.() ?? '');

  t.true(output.includes('run_subagent [explorer] find x'), `Expected title in output: ${output}`);
  t.true(output.includes('✔'), `Expected concise checkmark in output: ${output}`);
  t.true(output.includes('Created "src/test.txt"'), `Expected concise display action: ${output}`);
});
