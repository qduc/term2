// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import CommandMessage from './CommandMessage.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE } from '../tools/tool-names.js';

type FakeTimer = {
  advanceBy: (ms: number) => void;
  restore: () => void;
};

const createFakeTimerClock = (): FakeTimer => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { dueAt: number; callback: (...args: any[]) => void; args: any[] }>();

  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay = 0, ...args: any[]) => {
    const id = nextId++;
    timers.set(id, { dueAt: now + Math.max(0, Number(delay) || 0), callback, args });
    return id as any;
  }) as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((timerId: number | undefined) => {
    if (typeof timerId === 'number') {
      timers.delete(timerId);
    }
  }) as typeof globalThis.clearTimeout;

  const advanceBy = (ms: number) => {
    const targetTime = now + ms;

    while (true) {
      let nextTimerId: number | null = null;
      let nextDueAt = Number.POSITIVE_INFINITY;

      for (const [id, timer] of timers) {
        if (timer.dueAt < nextDueAt) {
          nextDueAt = timer.dueAt;
          nextTimerId = id;
        }
      }

      if (nextTimerId === null || nextDueAt > targetTime) {
        break;
      }

      now = nextDueAt;
      const timer = timers.get(nextTimerId);
      timers.delete(nextTimerId);
      timer?.callback(...timer.args);
    }

    now = targetTime;
  };

  return {
    advanceBy,
    restore: () => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
};

test('CommandMessage does not duplicate parameters when they are already in command string', async (t) => {
  const clock = createFakeTimerClock();
  const props = {
    command: 'shell: ls -la',
    toolName: 'shell',
    toolArgs: { command: 'ls -la' },
    status: 'running' as 'running' | 'pending' | 'completed' | 'failed',
  };

  let lastFrame: (() => string | undefined) | undefined;

  try {
    await act(async () => {
      ({ lastFrame } = render(<CommandMessage {...props} />));
      clock.advanceBy(1100);
    });

    const output = lastFrame?.() ?? '';

    // The bug would cause "ls -la" to appear twice
    // e.g. "$ shell: ls -la ls -la"

    // Count occurrences of "ls -la"
    const count = (output.match(/ls -la/g) || []).length;

    // It should only appear once in the command line
    t.is(count, 1, `Expected "ls -la" to appear once, but found ${count}. Output: ${output}`);
  } finally {
    clock.restore();
  }
});

test('CommandMessage still shows arguments for unknown tools where command is just toolName', async (t) => {
  const clock = createFakeTimerClock();
  const props = {
    command: 'unknown_tool',
    toolName: 'unknown_tool',
    toolArgs: { foo: 'bar' },
    status: 'running' as 'running' | 'pending' | 'completed' | 'failed',
  };

  let lastFrame: (() => string | undefined) | undefined;

  try {
    await act(async () => {
      ({ lastFrame } = render(<CommandMessage {...props} />));
      clock.advanceBy(1100);
    });

    const output = lastFrame?.() ?? '';

    t.true(output.includes('unknown_tool'));
    t.true(output.includes('foo=bar'));
  } finally {
    clock.restore();
  }
});

test('CommandMessage renders create_file with [CREATE] header and file path', async (t) => {
  const props = {
    command: 'create_file "src/new-file.ts"',
    toolName: TOOL_NAME_CREATE_FILE,
    toolArgs: { path: 'src/new-file.ts', content: 'console.log("hello");\n' },
    status: 'completed' as 'running' | 'pending' | 'completed' | 'failed',
    success: true,
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<CommandMessage {...props} />));
  });
  const output = lastFrame?.() ?? '';

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

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<CommandMessage {...props} />));
  });
  const output = lastFrame?.() ?? '';

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

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<CommandMessage {...props} />));
  });
  const output = lastFrame?.() ?? '';

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

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<CommandMessage {...props} />));
  });
  const output = lastFrame?.() ?? '';

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

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<CommandMessage {...props} />));
  });
  const output = lastFrame?.() ?? '';

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

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<CommandMessage {...props} />));
  });
  const output = lastFrame?.() ?? '';

  t.true(output.includes('[CREATE]'), `Expected "[CREATE]" in output: ${output}`);
  t.true(output.includes('Error'), `Expected error message in output: ${output}`);
});

test('CommandMessage truncates output and shows the last line when output is longer than 4 lines', async (t) => {
  const props = {
    command: 'shell: echo',
    toolName: 'shell',
    toolArgs: { command: 'echo' },
    status: 'completed' as const,
    success: true,
    output: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6',
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<CommandMessage {...props} />));
  });
  const output = lastFrame?.() ?? '';

  t.true(output.includes('line 1'), `Expected "line 1" in output: ${output}`);
  t.true(output.includes('line 2'), `Expected "line 2" in output: ${output}`);
  t.true(output.includes('line 3'), `Expected "line 3" in output: ${output}`);
  t.false(output.includes('line 4'), `Expected "line 4" to be truncated: ${output}`);
  t.false(output.includes('line 5'), `Expected "line 5" to be truncated: ${output}`);
  t.true(output.includes('line 6'), `Expected "line 6" (the last line) in output: ${output}`);
  t.true(output.includes('... (2 more lines)'), `Expected truncation count of 2: ${output}`);
});

test('CommandMessage does not truncate output and shows all lines when output is exactly 4 lines', async (t) => {
  const props = {
    command: 'shell: echo',
    toolName: 'shell',
    toolArgs: { command: 'echo' },
    status: 'completed' as const,
    success: true,
    output: 'line 1\nline 2\nline 3\nline 4',
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<CommandMessage {...props} />));
  });
  const output = lastFrame?.() ?? '';

  t.true(output.includes('line 1'));
  t.true(output.includes('line 2'));
  t.true(output.includes('line 3'));
  t.true(output.includes('line 4'));
  t.false(output.includes('more lines'));
});

test('CommandMessage does not truncate output when output is 3 lines', async (t) => {
  const props = {
    command: 'shell: echo',
    toolName: 'shell',
    toolArgs: { command: 'echo' },
    status: 'completed' as const,
    success: true,
    output: 'line 1\nline 2\nline 3',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('line 1'));
  t.true(output.includes('line 2'));
  t.true(output.includes('line 3'));
  t.false(output.includes('more lines'));
});

test('CommandMessage trims trailing newlines when checking for truncation', async (t) => {
  const props = {
    command: 'shell: echo',
    toolName: 'shell',
    toolArgs: { command: 'echo' },
    status: 'completed' as const,
    success: true,
    output: 'line 1\nline 2\nline 3\nline 4\n\n\n',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('line 1'));
  t.true(output.includes('line 2'));
  t.true(output.includes('line 3'));
  t.true(output.includes('line 4'));
  t.false(output.includes('more lines'));
});

test('CommandMessage renders shell approval rejection with [DENIED] and denial message', async (t) => {
  // Regression test: when shell approval is denied, the UI must render the attempted
  // command and the denial reason so the user knows what was blocked and why.
  const props = {
    command: 'rm -rf /dangerous',
    toolName: 'shell',
    toolArgs: { command: 'rm -rf /dangerous' },
    status: 'completed' as 'completed',
    success: false,
    isApprovalRejection: true,
    output: "Tool execution was not approved. User's reason: too risky",
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('DENIED'), `Expected [DENIED] marker in output: ${output}`);
  t.true(output.includes('not approved'), `Expected denial message in output: ${output}`);
});

test('CommandMessage renders shell approval rejection without command in output when only command field is provided', async (t) => {
  const props = {
    command: 'shell: rm -rf /',
    status: 'completed' as 'completed',
    success: false,
    isApprovalRejection: true,
    output: "Tool execution was not approved. User's reason: not safe",
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('DENIED'), `Expected [DENIED] marker in output: ${output}`);
  t.true(output.includes('not safe'), `Expected denial reason in output: ${output}`);
});
