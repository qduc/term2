// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import SubagentActivityMessage from './SubagentActivityMessage.js';
import { TOOL_NAME_CREATE_FILE } from '../../tools/tool-names.js';

test.serial('SubagentActivityMessage renders plain string tools', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'running',
      tools: ['read_file "source/app.tsx" (Success)'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />, t);
  const output = toVisibleText(lastFrame() ?? '');

  t.true(output.includes('run_subagent [explorer] find x'), `Expected title in output: ${output}`);
  t.true(output.includes('✔ read_file "source/app.tsx"'), `Expected tool in output: ${output}`);
});

test.serial('SubagentActivityMessage renders write tool CommandMessage concisely', async (t) => {
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

  const originalForceColor = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '1';
  t.teardown(() => {
    if (originalForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = originalForceColor;
    }
  });
  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />, t);
  const rawOutput = lastFrame() ?? '';
  const output = toVisibleText(rawOutput);

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
        rawOutput.includes('38;5;103') ||
        rawOutput.includes('38;5;67') ||
        rawOutput.includes('36;100;116;139') ||
        rawOutput.includes('38;2;100') ||
        rawOutput.includes('90m') ||
        rawOutput.includes('37m'),
      `Expected color escape sequence in raw output: ${JSON.stringify(rawOutput)}`,
    );
  }
});

test.serial('SubagentActivityMessage renders failed string tool with cross', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['read_file "source/app.tsx" (Failed)'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />, t);
  const output = toVisibleText(lastFrame() ?? '');

  t.true(output.includes('✖ read_file "source/app.tsx"'), `Expected cross and tool: ${output}`);
});

test.serial('SubagentActivityMessage renders failed-with-reason string tool with cross', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['read_file "source/app.tsx" (Failed: Permission denied)'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />, t);
  const output = toVisibleText(lastFrame() ?? '');

  t.true(output.includes('✖ read_file "source/app.tsx"'), `Expected cross and tool: ${output}`);
});

test.serial('SubagentActivityMessage renders cancelled string tool with cross', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['read_file "source/app.tsx" (Cancelled)'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />, t);
  const output = toVisibleText(lastFrame() ?? '');

  t.true(output.includes('✖ read_file "source/app.tsx"'), `Expected cross and tool: ${output}`);
});

test.serial('SubagentActivityMessage renders match-count string tool with checkmark', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['grep "TODO" (2 matches)'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />, t);
  const output = toVisibleText(lastFrame() ?? '');

  t.true(output.includes('✔ grep "TODO"'), `Expected checkmark and tool: ${output}`);
});

test.serial('SubagentActivityMessage renders single-match string tool with checkmark', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['grep "TODO" (1 match)'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />, t);
  const output = toVisibleText(lastFrame() ?? '');

  t.true(output.includes('✔ grep "TODO"'), `Expected checkmark and tool: ${output}`);
});

test.serial('SubagentActivityMessage renders unknown-suffix tool as running when activity is running', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'running',
      tools: ['read_file "source/app.tsx"'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />, t);
  const output = toVisibleText(lastFrame() ?? '');

  t.true(output.includes('\u25b6 read_file "source/app.tsx"'), `Expected arrow and tool: ${output}`);
});

test.serial('SubagentActivityMessage renders unknown-suffix tool as success when activity is completed', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['read_file "source/app.tsx"'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />, t);
  const output = toVisibleText(lastFrame() ?? '');

  t.true(output.includes('\u2714 read_file "source/app.tsx"'), `Expected checkmark and tool: ${output}`);
});

test.serial('SubagentActivityMessage does not misparse embedded (Failed: in arguments', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['write_file "notes (Failed: old).txt" (Success)'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />, t);
  const output = toVisibleText(lastFrame() ?? '');

  t.true(output.includes('\u2714'), `Expected checkmark: ${output}`);
  t.true(output.includes('write_file "notes (Failed: old).txt"'), `Expected full tool with embedded text: ${output}`);
});
