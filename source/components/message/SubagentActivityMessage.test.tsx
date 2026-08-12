// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
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

it.sequential(
  'SubagentActivityMessage preserves the legacy asynchronous tool label when its log lacks parentTool',
  async () => {
    const { lastFrame } = await renderInAct(
      <SubagentActivityMessage
        msg={{
          role: 'explorer',
          task: 'find x',
          status: 'running',
          tools: [],
          async: true,
        }}
      />,
    );
    const output = toVisibleText(lastFrame() ?? '');

    expect(output).toContain('run_subagent_async [explorer] find x');
    expect(output).not.toContain('$ run_subagent [explorer] find x');
  },
);

it.sequential('SubagentActivityMessage uses the unified tool label for a background start', async () => {
  const { lastFrame } = await renderInAct(
    <SubagentActivityMessage
      msg={{
        role: 'explorer',
        task: 'find x',
        status: 'running',
        tools: [],
        async: true,
        parentTool: 'run_subagent',
      }}
    />,
  );
  const output = toVisibleText(lastFrame() ?? '');

  expect(output).toContain('run_subagent [explorer] find x');
  expect(output).not.toContain('run_subagent_async');
});

it.sequential('SubagentActivityMessage renders write tool CommandMessage concisely', async () => {
  const writeMsg = {
    id: 'cmd-w1',
    sender: 'command' as const,
    status: 'completed' as const,
    command: 'create_file "src/test.txt"',
    output: '',
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

it.sequential(
  'SubagentActivityMessage filters out tool start event (without result suffix) when activity is running',
  async () => {
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

    expect(output.includes('read_file')).toBe(false);
  },
);

it.sequential('SubagentActivityMessage filters out running write tool CommandMessage object', async () => {
  const runningWriteMsg = {
    id: 'cmd-w1',
    sender: 'command' as const,
    status: 'running' as const,
    command: 'create_file "src/test.txt"',
    output: '',
    toolName: TOOL_NAME_CREATE_FILE,
    toolArgs: { path: 'src/test.txt', content: 'hello' },
  };

  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'running',
      tools: [runningWriteMsg],
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />);
  const output = toVisibleText(lastFrame() ?? '');

  expect(output.includes('create_file')).toBe(false);
  expect(output.includes('Created')).toBe(false);
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
    expect(output.includes('Here is the subagent answer.')).toBe(true);
    expect(output.includes('This is the second paragraph of the answer.')).toBe(true);
    expect(output.includes('read_file')).toBe(false);
  },
);

it.sequential('SubagentActivityMessage freezes a transferred card with its last tools', async () => {
  const { lastFrame } = await renderInAct(
    <SubagentActivityMessage
      msg={{
        role: 'explorer',
        task: 'find x',
        status: 'backgrounded',
        parentTool: 'run_subagent',
        tools: ['read_file "source/app.tsx" (Success)'],
        finalText: 'should not replace the peek',
      }}
    />,
  );
  const output = toVisibleText(lastFrame() ?? '');

  expect(output).toContain('run_subagent [explorer] find x');
  expect(output).toContain('— moved to background');
  expect(output).toContain('✔ read_file "source/app.tsx"');
  expect(output).not.toContain('should not replace the peek');
});

it.sequential('SubagentActivityMessage appends failure reason to status suffix when error is present', async () => {
  const props = {
    msg: {
      role: 'explorer',
      task: 'find x',
      status: 'failed',
      error: 'Max turns (100) exceeded',
    },
  };

  const { lastFrame } = await renderInAct(<SubagentActivityMessage {...props} />);
  const output = toVisibleText(lastFrame() ?? '');

  expect(output.includes('— failed: Max turns (100) exceeded')).toBe(true);
});
