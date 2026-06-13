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
  t.true(output.includes('✔ read_file "source/app.tsx"'), `Expected tool in output: ${output}`);
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

test('SubagentActivityMessage renders failed string tool with cross', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['read_file "source/app.tsx" (Failed)'],
    },
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<SubagentActivityMessage {...props} />));
  });
  const output = stripAnsi(lastFrame?.() ?? '');

  t.true(output.includes('✖ read_file "source/app.tsx"'), `Expected cross and tool: ${output}`);
});

test('SubagentActivityMessage renders failed-with-reason string tool with cross', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['read_file "source/app.tsx" (Failed: Permission denied)'],
    },
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<SubagentActivityMessage {...props} />));
  });
  const output = stripAnsi(lastFrame?.() ?? '');

  t.true(output.includes('✖ read_file "source/app.tsx"'), `Expected cross and tool: ${output}`);
});

test('SubagentActivityMessage renders cancelled string tool with cross', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['read_file "source/app.tsx" (Cancelled)'],
    },
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<SubagentActivityMessage {...props} />));
  });
  const output = stripAnsi(lastFrame?.() ?? '');

  t.true(output.includes('✖ read_file "source/app.tsx"'), `Expected cross and tool: ${output}`);
});

test('SubagentActivityMessage renders match-count string tool with checkmark', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['grep "TODO" (2 matches)'],
    },
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<SubagentActivityMessage {...props} />));
  });
  const output = stripAnsi(lastFrame?.() ?? '');

  t.true(output.includes('✔ grep "TODO"'), `Expected checkmark and tool: ${output}`);
});

test('SubagentActivityMessage renders single-match string tool with checkmark', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['grep "TODO" (1 match)'],
    },
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<SubagentActivityMessage {...props} />));
  });
  const output = stripAnsi(lastFrame?.() ?? '');

  t.true(output.includes('✔ grep "TODO"'), `Expected checkmark and tool: ${output}`);
});

test('SubagentActivityMessage renders unknown-suffix tool as running when activity is running', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'running',
      tools: ['read_file "source/app.tsx"'],
    },
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<SubagentActivityMessage {...props} />));
  });
  const output = stripAnsi(lastFrame?.() ?? '');

  t.true(output.includes('\u25b6 read_file "source/app.tsx"'), `Expected arrow and tool: ${output}`);
});

test('SubagentActivityMessage renders unknown-suffix tool as success when activity is completed', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['read_file "source/app.tsx"'],
    },
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<SubagentActivityMessage {...props} />));
  });
  const output = stripAnsi(lastFrame?.() ?? '');

  t.true(output.includes('\u2714 read_file "source/app.tsx"'), `Expected checkmark and tool: ${output}`);
});

test('SubagentActivityMessage does not misparse embedded (Failed: in arguments', async (t) => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'completed',
      tools: ['write_file "notes (Failed: old).txt" (Success)'],
    },
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<SubagentActivityMessage {...props} />));
  });
  const output = stripAnsi(lastFrame?.() ?? '');

  t.true(output.includes('\u2714'), `Expected checkmark: ${output}`);
  t.true(output.includes('write_file "notes (Failed: old).txt"'), `Expected full tool with embedded text: ${output}`);
});
