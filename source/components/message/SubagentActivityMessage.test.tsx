// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import SubagentActivityMessage from './SubagentActivityMessage.js';
import { TOOL_NAME_CREATE_FILE } from '../../tools/tool-names.js';

it.sequential('SubagentActivityMessage renders plain string tools', async () => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'running',
      tools: ['read_file "source/app.tsx" (Success)'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />);
  const output = toVisibleText(lastFrame() ?? '');

  expect(output.includes('run_subagent [explorer] find x')).toBe(true);
  expect(output.includes('✔ read_file "source/app.tsx"')).toBe(true);
});

it.sequential('SubagentActivityMessage renders write tool CommandMessage concisely', async () => {
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

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />);
  const rawOutput = lastFrame() ?? '';
  const output = toVisibleText(rawOutput);

  expect(output.includes('run_subagent [explorer] find x')).toBe(true);
  expect(output.includes('✔')).toBe(true);
  expect(output.includes('Created "src/test.txt"')).toBe(true);

  // Verify left-alignment: no leading spaces before the checkmark
  const lines = output.split('\n').map((l) => l.trimEnd());
  expect(lines.some((line) => line.startsWith('✔ Created "src/test.txt"'))).toBe(true);

  // Verify the hex color #64748b is applied if ANSI colors are generated
  if (rawOutput !== output) {
    expect(
      rawOutput.includes('100;116;139') ||
        rawOutput.includes('38;2;100;116;139') ||
        rawOutput.includes('38;5;103') ||
        rawOutput.includes('38;5;67') ||
        rawOutput.includes('36;100;116;139') ||
        rawOutput.includes('38;2;100') ||
        rawOutput.includes('90m') ||
        rawOutput.includes('37m'),
    ).toBe(true);
  }

  if (originalForceColor === undefined) {
    delete process.env.FORCE_COLOR;
  } else {
    process.env.FORCE_COLOR = originalForceColor;
  }
});

it.sequential('SubagentActivityMessage renders failed string tool with cross', async () => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['read_file "source/app.tsx" (Failed)'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />);
  const output = toVisibleText(lastFrame() ?? '');

  expect(output.includes('✖ read_file "source/app.tsx"')).toBe(true);
});

it.sequential('SubagentActivityMessage renders failed-with-reason string tool with cross', async () => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['read_file "source/app.tsx" (Failed: Permission denied)'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />);
  const output = toVisibleText(lastFrame() ?? '');

  expect(output.includes('✖ read_file "source/app.tsx"')).toBe(true);
});

it.sequential('SubagentActivityMessage renders cancelled string tool with cross', async () => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['read_file "source/app.tsx" (Cancelled)'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />);
  const output = toVisibleText(lastFrame() ?? '');

  expect(output.includes('✖ read_file "source/app.tsx"')).toBe(true);
});

it.sequential('SubagentActivityMessage renders match-count string tool with checkmark', async () => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['grep "TODO" (2 matches)'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />);
  const output = toVisibleText(lastFrame() ?? '');

  expect(output.includes('✔ grep "TODO"')).toBe(true);
});

it.sequential('SubagentActivityMessage renders single-match string tool with checkmark', async () => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['grep "TODO" (1 match)'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />);
  const output = toVisibleText(lastFrame() ?? '');

  expect(output.includes('✔ grep "TODO"')).toBe(true);
});

it.sequential('SubagentActivityMessage renders unknown-suffix tool as running when activity is running', async () => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'running',
      tools: ['read_file "source/app.tsx"'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />);
  const output = toVisibleText(lastFrame() ?? '');

  expect(output.includes('\u25b6 read_file "source/app.tsx"')).toBe(true);
});

it.sequential('SubagentActivityMessage renders unknown-suffix tool as success when activity is completed', async () => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['read_file "source/app.tsx"'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />);
  const output = toVisibleText(lastFrame() ?? '');

  expect(output.includes('\u2714 read_file "source/app.tsx"')).toBe(true);
});

it.sequential('SubagentActivityMessage does not misparse embedded (Failed: in arguments', async () => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['write_file "notes (Failed: old).txt" (Success)'],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />);
  const output = toVisibleText(lastFrame() ?? '');

  expect(output.includes('\u2714')).toBe(true);
  expect(output.includes('write_file "notes (Failed: old).txt"')).toBe(true);
});

it.sequential(
  'SubagentActivityMessage replaces tool timeline with first paragraph of finalText when completed',
  async () => {
    const props = {
      msg: {
        role: 'explorer',
        task: 'find x',
        status: 'completed',
        tools: ['read_file "source/app.tsx" (Success)'],
        finalText: 'Here is the subagent answer.\n\nThis is the second paragraph of the answer.',
      },
    };

    const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />);
    const output = toVisibleText(lastFrame() ?? '');

    expect(output.includes('run_subagent [explorer] find x')).toBe(true);
    expect(output.includes('Response: Here is the subagent answer.')).toBe(true);
    expect(output.includes('This is the second paragraph of the answer.')).toBe(false);
    expect(output.includes('read_file')).toBe(false);
  },
);
