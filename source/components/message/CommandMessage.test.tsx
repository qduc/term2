// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import CommandMessage from './CommandMessage.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';

// Note: using `it` from vitest globally (no AVA serial needed)
const originalConsoleError = console.error;
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const shouldSuppressActWarning = (text: string) =>
  text.includes('not wrapped in act(...)') || text.includes('overlapping act() calls');

beforeAll(() => {
  console.error = (...args: Parameters<typeof console.error>) => {
    const text = args
      .map((arg) =>
        typeof arg === 'string' ? arg : typeof arg === 'object' && arg ? JSON.stringify(arg) : String(arg),
      )
      .join(' ');
    if (shouldSuppressActWarning(text)) {
      return;
    }

    originalConsoleError(...args);
  };

  process.stderr.write = ((chunk: any, encoding?: any, callback?: any) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (shouldSuppressActWarning(text)) {
      if (typeof callback === 'function') {
        callback();
      }
      return true;
    }
    return originalStderrWrite(chunk, encoding as any, callback);
  }) as typeof process.stderr.write;
});

afterAll(() => {
  console.error = originalConsoleError;
  process.stderr.write = originalStderrWrite;
});

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

const stripAnsi = (text: string) => text.replaceAll(/\u001B\[[0-9;]*m/g, '');

const advanceClockInAct = async (clock: FakeTimer, ms: number) => {
  await act(async () => {
    clock.advanceBy(ms);
    await Promise.resolve();
  });
};

it('CommandMessage does not duplicate parameters when they are already in command string', async () => {
  const clock = createFakeTimerClock();
  const props = {
    command: 'shell: ls -la',
    toolName: 'shell',
    toolArgs: { command: 'ls -la' },
    status: 'running' as 'running' | 'pending' | 'completed' | 'failed',
  };

  let lastFrame: (() => string | undefined) | undefined;

  try {
    ({ lastFrame } = await renderInAct(<CommandMessage {...props} />));
    await advanceClockInAct(clock, 1100);

    const output = lastFrame?.() ?? '';

    // The bug would cause "ls -la" to appear twice
    // e.g. "$ shell: ls -la ls -la"

    // Count occurrences of "ls -la"
    const count = (output.match(/ls -la/g) || []).length;

    // It should only appear once in the command line
    expect(count, `Expected "ls -la" to appear once, but found ${count}. Output: ${output}`).toBe(1);
  } finally {
    clock.restore();
  }
});

it('CommandMessage still shows arguments for unknown tools where command is just toolName', async () => {
  const clock = createFakeTimerClock();
  const props = {
    command: 'unknown_tool',
    toolName: 'unknown_tool',
    toolArgs: { foo: 'bar' },
    status: 'running' as 'running' | 'pending' | 'completed' | 'failed',
  };

  let lastFrame: (() => string | undefined) | undefined;

  try {
    ({ lastFrame } = await renderInAct(<CommandMessage {...props} />));
    await advanceClockInAct(clock, 1100);

    const output = lastFrame?.() ?? '';

    expect(output.includes('unknown_tool')).toBe(true);
    expect(output.includes('foo=bar')).toBe(true);
  } finally {
    clock.restore();
  }
});

it('CommandMessage renders create_file with [CREATE] header and file path', async () => {
  const props = {
    command: 'create_file "src/new-file.ts"',
    toolName: TOOL_NAME_CREATE_FILE,
    toolArgs: { path: 'src/new-file.ts', content: 'console.log("hello");\n' },
    status: 'completed' as 'running' | 'pending' | 'completed' | 'failed',
    success: true,
  };

  let lastFrame: (() => string | undefined) | undefined;
  ({ lastFrame } = await renderInAct(<CommandMessage {...props} />));
  const output = lastFrame?.() ?? '';

  expect(output.includes('[CREATE]')).toBe(true);
  expect(output.includes('src/new-file.ts')).toBe(true);
});

it('CommandMessage renders create_file content as diff with + prefix', async () => {
  const props = {
    command: 'create_file "src/new-file.ts"',
    toolName: TOOL_NAME_CREATE_FILE,
    toolArgs: { path: 'src/new-file.ts', content: 'line 1\nline 2\n' },
    status: 'completed' as 'running' | 'pending' | 'completed' | 'failed',
    success: true,
  };

  let lastFrame: (() => string | undefined) | undefined;
  ({ lastFrame } = await renderInAct(<CommandMessage {...props} />));
  const output = lastFrame?.() ?? '';

  expect(output.includes('+line 1')).toBe(true);
  expect(output.includes('+line 2')).toBe(true);
});

it('CommandMessage renders apply_patch update_file with [PATCH] header and diff', async () => {
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
  ({ lastFrame } = await renderInAct(<CommandMessage {...props} />));
  const output = lastFrame?.() ?? '';

  expect(output.includes('[PATCH]')).toBe(true);
  expect(output.includes('src/file.ts')).toBe(true);
  expect(output.includes('-old line')).toBe(true);
  expect(output.includes('+new line')).toBe(true);
});

it('CommandMessage renders apply_patch line counts in concise mode', async () => {
  const props = {
    command: 'apply_patch update_file src/file.ts',
    toolName: TOOL_NAME_APPLY_PATCH,
    toolArgs: { path: 'src/file.ts', diff: ' context\n-old line\n+new line\n', type: 'update_file' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  expect(output.includes('Patched update_file src/file.ts')).toBe(true);
  expect(output.includes('(+1 -1)')).toBe(true);
});

it('CommandMessage renders search_replace line counts in concise mode', async () => {
  const props = {
    command: 'search_replace',
    toolName: TOOL_NAME_SEARCH_REPLACE,
    toolArgs: {
      path: 'src/file.ts',
      search_content: 'hello',
      replace_content: 'world',
    },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  expect(output.includes('Edited')).toBe(true);
  expect(output.includes('"src/file.ts"')).toBe(true);
  expect(output.includes('hello')).toBe(false);
  expect(output.includes('world')).toBe(false);
  expect(output.includes('(+1 -1)')).toBe(true);
});

it('CommandMessage renders search_replace multiple replacements in concise mode', async () => {
  const props = {
    command: 'search_replace',
    toolName: TOOL_NAME_SEARCH_REPLACE,
    toolArgs: {
      path: 'src/file.ts',
      replacements: [
        { search_content: 'hello', replace_content: 'world' },
        { search_content: 'foo', replace_content: 'bar' },
      ],
    },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  expect(output.includes('Edited')).toBe(true);
  expect(output.includes('"src/file.ts" (+ 1 more)')).toBe(true);
  expect(output.includes('hello')).toBe(false);
  expect(output.includes('world')).toBe(false);
  expect(output.includes('(+2 -2)')).toBe(true);
});

it('CommandMessage renders apply_patch create_file with [CREATE FILE] header and diff', async () => {
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
  ({ lastFrame } = await renderInAct(<CommandMessage {...props} />));
  const output = lastFrame?.() ?? '';

  expect(output.includes('[CREATE FILE]')).toBe(true);
  expect(output.includes('src/new.ts')).toBe(true);
  expect(output.includes('+line 1')).toBe(true);
});

it('CommandMessage renders apply_patch with only output when hadApproval is true', async () => {
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
  ({ lastFrame } = await renderInAct(<CommandMessage {...props} />));
  const output = lastFrame?.() ?? '';

  expect(output.includes('[PATCH]')).toBe(false);
  expect(output.includes('Updated src/file.ts')).toBe(true);
});

it('CommandMessage renders create_file failure in red', async () => {
  const props = {
    command: 'create_file "src/existing.ts"',
    toolName: TOOL_NAME_CREATE_FILE,
    toolArgs: { path: 'src/existing.ts', content: 'content' },
    status: 'completed' as 'running' | 'pending' | 'completed' | 'failed',
    success: false,
    output: 'Error: File already exists at src/existing.ts.',
  };

  let lastFrame: (() => string | undefined) | undefined;
  ({ lastFrame } = await renderInAct(<CommandMessage {...props} />));
  const output = lastFrame?.() ?? '';

  expect(output.includes('[CREATE]')).toBe(true);
  expect(output.includes('Error')).toBe(true);
});

it('CommandMessage truncates output and shows the last line when output is longer than 4 lines', async () => {
  const props = {
    command: 'shell: echo',
    toolName: 'shell',
    toolArgs: { command: 'echo' },
    status: 'completed' as const,
    success: true,
    output: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6',
  };

  let lastFrame: (() => string | undefined) | undefined;
  ({ lastFrame } = await renderInAct(<CommandMessage {...props} />));
  const output = lastFrame?.() ?? '';

  expect(output.includes('line 1')).toBe(true);
  expect(output.includes('line 2')).toBe(true);
  expect(output.includes('line 3')).toBe(true);
  expect(output.includes('line 4')).toBe(false);
  expect(output.includes('line 5')).toBe(false);
  expect(output.includes('line 6')).toBe(true);
  expect(output.includes('... (2 more lines)')).toBe(true);
});

it('CommandMessage does not truncate output and shows all lines when output is exactly 4 lines', async () => {
  const props = {
    command: 'shell: echo',
    toolName: 'shell',
    toolArgs: { command: 'echo' },
    status: 'completed' as const,
    success: true,
    output: 'line 1\nline 2\nline 3\nline 4',
  };

  let lastFrame: (() => string | undefined) | undefined;
  ({ lastFrame } = await renderInAct(<CommandMessage {...props} />));
  const output = lastFrame?.() ?? '';

  expect(output.includes('line 1')).toBe(true);
  expect(output.includes('line 2')).toBe(true);
  expect(output.includes('line 3')).toBe(true);
  expect(output.includes('line 4')).toBe(true);
  expect(output.includes('more lines')).toBe(false);
});

it('CommandMessage does not truncate output when output is 3 lines', async () => {
  const props = {
    command: 'shell: echo',
    toolName: 'shell',
    toolArgs: { command: 'echo' },
    status: 'completed' as const,
    success: true,
    output: 'line 1\nline 2\nline 3',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('line 1')).toBe(true);
  expect(output.includes('line 2')).toBe(true);
  expect(output.includes('line 3')).toBe(true);
  expect(output.includes('more lines')).toBe(false);
});

it('CommandMessage trims trailing newlines when checking for truncation', async () => {
  const props = {
    command: 'shell: echo',
    toolName: 'shell',
    toolArgs: { command: 'echo' },
    status: 'completed' as const,
    success: true,
    output: 'line 1\nline 2\nline 3\nline 4\n\n\n',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('line 1')).toBe(true);
  expect(output.includes('line 2')).toBe(true);
  expect(output.includes('line 3')).toBe(true);
  expect(output.includes('line 4')).toBe(true);
  expect(output.includes('more lines')).toBe(false);
});

it('CommandMessage renders shell approval rejection with [DENIED] and denial message', async () => {
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

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('DENIED')).toBe(true);
  expect(output.includes('not approved')).toBe(true);
});

it('CommandMessage renders shell approval rejection without command in output when only command field is provided', async () => {
  const props = {
    command: 'shell: rm -rf /',
    status: 'completed' as 'completed',
    success: false,
    isApprovalRejection: true,
    output: "Tool execution was not approved. User's reason: not safe",
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('DENIED')).toBe(true);
  expect(output.includes('not safe')).toBe(true);
});

it('CommandMessage renders successfully completed shell command on a single line in concise mode', async () => {
  const props = {
    command: 'npm test',
    toolName: 'shell',
    toolArgs: { command: 'npm test' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'All tests passed\nOK',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = toVisibleText(lastFrame() ?? '');

  expect(output.includes('✔')).toBe(true);
  expect(output.includes('$ npm test')).toBe(true);
  expect(output.includes('All tests passed')).toBe(false);
});

it('CommandMessage renders running shell command on a single line in concise mode', async () => {
  const clock = createFakeTimerClock();
  const props = {
    command: 'npm run dev',
    toolName: 'shell',
    toolArgs: { command: 'npm run dev' },
    status: 'running' as const,
    displayMode: 'concise' as const,
  };

  let lastFrame: (() => string | undefined) | undefined;
  try {
    ({ lastFrame } = await renderInAct(<CommandMessage {...props} />));
    await advanceClockInAct(clock, 1100);

    const output = toVisibleText(lastFrame?.() ?? '');

    expect(output.includes('▶')).toBe(true);
    expect(output.includes('$ npm run dev')).toBe(true);
  } finally {
    clock.restore();
  }
});

it('CommandMessage renders failed command on two lines in concise mode', async () => {
  const props = {
    command: 'npm test',
    toolName: 'shell',
    toolArgs: { command: 'npm test' },
    status: 'completed' as const,
    success: false,
    displayMode: 'concise' as const,
    failureReason: 'Test suite failed',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = toVisibleText(lastFrame() ?? '');

  // Expect two lines
  const lines = output.trim().split('\n');
  expect(lines.length >= 2).toBe(true);
  expect(lines[0]!.includes('✖')).toBe(true);
  expect(lines[0]!.includes('$ npm test')).toBe(true);
  expect(output.includes('Test suite failed')).toBe(true);
});

it('CommandMessage renders non-shell tool concisely on a single line', async () => {
  const props = {
    command: 'create_file',
    toolName: 'create_file',
    toolArgs: { path: 'src/new-file.ts', content: 'console.log("hello");' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('✔')).toBe(true);
  expect(output.includes('Created')).toBe(true);
  expect(output.includes('src/new-file.ts')).toBe(true);
  expect(output.includes('console.log')).toBe(false);
});

it('CommandMessage renders grep case-insensitive flag in concise mode', async () => {
  const props = {
    command: 'grep',
    toolName: 'grep',
    toolArgs: { pattern: 'hello', path: 'source', case_sensitive: false },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('Searched')).toBe(true);
  expect(output.includes('--ignore-case')).toBe(true);
});

it('CommandMessage shows match count for grep tool in concise mode', async () => {
  const props = {
    command: 'grep',
    toolName: 'grep',
    toolArgs: { pattern: 'hello', path: 'source' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'file1.ts:1:hello\nfile2.ts:3:hello world\nfile3.ts:7:hello',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('(3 matches)')).toBe(true);
});

it('CommandMessage shows singular match count for grep with 1 result', async () => {
  const props = {
    command: 'grep',
    toolName: 'grep',
    toolArgs: { pattern: 'hello', path: 'source' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'file1.ts:1:hello',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('(1 match)')).toBe(true);
  expect(output.includes('matches')).toBe(false);
});

it('CommandMessage shows match count for find_files tool in concise mode', async () => {
  const props = {
    command: 'find_files',
    toolName: 'find_files',
    toolArgs: { pattern: '*.ts', path: 'source' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'source/a.ts\nsource/b.ts\nsource/c.ts\nsource/d.ts\nsource/e.ts',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('(5 matches)')).toBe(true);
});

it('CommandMessage shows match count for shell grep command in concise mode', async () => {
  const props = {
    command: 'grep -rn hello source/',
    toolName: 'shell',
    toolArgs: { command: 'grep -rn hello source/' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'source/a.ts:1:hello\nsource/b.ts:3:hello',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('(2 matches)')).toBe(true);
});

it('CommandMessage shows match count for shell rg command in concise mode', async () => {
  const props = {
    command: 'rg hello source/',
    toolName: 'shell',
    toolArgs: { command: 'rg hello source/' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'source/a.ts\n1:hello\n\nsource/b.ts\n3:hello world',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('(4 matches)')).toBe(true);
});

it('CommandMessage suppresses rg stderr and keeps the match count in concise mode', async () => {
  const props = {
    command: 'rg hello source/',
    toolName: 'shell',
    toolArgs: { command: 'rg hello source/' },
    status: 'completed' as const,
    success: false,
    displayMode: 'concise' as const,
    failureReason: 'rg: source/missing.ts: No such file or directory\nsource/a.ts:1:hello',
    output: 'rg: source/missing.ts: No such file or directory\nsource/a.ts:1:hello',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  expect(output.includes('(1 match)')).toBe(true);
  expect(output.includes('rg: source/missing.ts')).toBe(false);
  expect(output.includes('source/a.ts:1:hello')).toBe(true);
});

it('CommandMessage shows match count for shell find command in concise mode', async () => {
  const props = {
    command: 'find . -name *.ts',
    toolName: 'shell',
    toolArgs: { command: 'find . -name *.ts' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: './a.ts\n./b.ts\n./c.ts',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('(3 matches)')).toBe(true);
});

it('CommandMessage shows match count for shell fd command in concise mode', async () => {
  const props = {
    command: 'fd test.ts',
    toolName: 'shell',
    toolArgs: { command: 'fd test.ts' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'source/test.ts\nsource/components/test.ts',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('(2 matches)')).toBe(true);
});

it('CommandMessage does not show match count for non-search shell command in concise mode', async () => {
  const props = {
    command: 'npm test',
    toolName: 'shell',
    toolArgs: { command: 'npm test' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'All tests passed\nOK',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('match')).toBe(false);
});

it('CommandMessage renders grep results grouped by file in standard mode', async () => {
  const props = {
    command: 'grep',
    toolName: 'grep',
    toolArgs: { pattern: 'hello', path: 'source' },
    status: 'completed' as const,
    success: true,
    displayMode: 'standard' as const,
    output: 'file1.ts:1:hello\nfile2.ts:3:hello',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('file1.ts')).toBe(true);
  expect(output.includes('file2.ts')).toBe(true);
  expect(output.includes('GREP RESULTS')).toBe(true);
});

it('CommandMessage does not show match count when output is empty', async () => {
  const props = {
    command: 'grep',
    toolName: 'grep',
    toolArgs: { pattern: 'nonexistent', path: 'source' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: '',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('match')).toBe(false);
});

it('CommandMessage does not show match count when output is "No matches found."', async () => {
  const props = {
    command: 'grep',
    toolName: 'grep',
    toolArgs: { pattern: 'nonexistent', path: 'source' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'No matches found.',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  expect(output.includes('match')).toBe(false);
});

it('CommandMessage truncates error message in concise mode when error is longer than 4 lines', async () => {
  const longError = 'Error line 1\nError line 2\nError line 3\nError line 4\nError line 5\nError line 6';
  const props = {
    command: 'npm test',
    toolName: 'shell',
    toolArgs: { command: 'npm test' },
    status: 'failed' as const,
    success: false,
    displayMode: 'concise' as const,
    failureReason: longError,
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  // Should show first 3 lines
  expect(output.includes('Error line 1')).toBe(true);
  expect(output.includes('Error line 2')).toBe(true);
  expect(output.includes('Error line 3')).toBe(true);
  // Should NOT show middle lines
  expect(output.includes('Error line 4')).toBe(false);
  expect(output.includes('Error line 5')).toBe(false);
  // Should show last line
  expect(output.includes('Error line 6')).toBe(true);
  // Should show truncation indicator
  expect(output.includes('more lines')).toBe(true);
});

it('CommandMessage renders read_file with line numbers in standard mode', async () => {
  const props = {
    command: 'read_file',
    toolName: 'read_file',
    toolArgs: { path: 'src/main.ts', start_line: 1, end_line: 2 },
    status: 'completed' as const,
    success: true,
    displayMode: 'standard' as const,
    output: 'File: src/main.ts (2 lines) [lines 1-2]\n===\nimport { foo } from "bar";\nfoo();',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  expect(output.includes('[READ FILE]')).toBe(true);
  expect(output.includes('src/main.ts')).toBe(true);
  expect(output.includes('1 │ import { foo } from "bar";')).toBe(true);
  expect(output.includes('2 │ foo();')).toBe(true);
});

it('CommandMessage renders find_files lists in standard mode', async () => {
  const props = {
    command: 'find_files',
    toolName: 'find_files',
    toolArgs: { pattern: '*.ts' },
    status: 'completed' as const,
    success: true,
    displayMode: 'standard' as const,
    output: 'src/a.ts\nsrc/b.ts',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  expect(output.includes('[FILE SEARCH]')).toBe(true);
  expect(output.includes('📄 src/a.ts')).toBe(true);
  expect(output.includes('📄 src/b.ts')).toBe(true);
});

it('CommandMessage renders subagent card in standard mode', async () => {
  const props = {
    command: 'run_subagent',
    toolName: 'run_subagent',
    toolArgs: { role: 'worker', task: 'some task' },
    status: 'completed' as const,
    success: true,
    displayMode: 'standard' as const,
    output: 'Status: completed\nTools used: shell(3)\nFiles changed: src/a.ts\n\nSubagent finished successfully!',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  expect(output.includes('[SUBAGENT]')).toBe(true);
  expect(output.includes('worker')).toBe(true);
  expect(output.includes('COMPLETED')).toBe(true);
  expect(output.includes('Tools: shell(3)')).toBe(true);
  expect(output.includes('Changed: src/a.ts')).toBe(true);
  expect(output.includes('Subagent finished successfully!')).toBe(true);
});

it('CommandMessage renders web_search dashboard in standard mode', async () => {
  const props = {
    command: 'web_search',
    toolName: 'web_search',
    toolArgs: { query: 'latest Ink' },
    status: 'completed' as const,
    success: true,
    displayMode: 'standard' as const,
    output:
      '## Answer\n\nInk is a React renderer.\n\n## Search Results\n\n### 1. Ink GitHub\n**URL:** https://github.com/vadimdemedes/ink\n\nReact for CLI.',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  expect(output.includes('[WEB SEARCH]')).toBe(true);
  expect(output.includes('Answer Summary')).toBe(true);
  expect(output.includes('Ink is a React renderer.')).toBe(true);
  expect(output.includes('1. Ink GitHub')).toBe(true);
  expect(output.includes('https://github.com/vadimdemedes/ink')).toBe(true);
  expect(output.includes('React for CLI.')).toBe(true);
});

it('CommandMessage renders web_fetch result in standard mode', async () => {
  const props = {
    command: 'web_fetch',
    toolName: 'web_fetch',
    toolArgs: { url: 'https://example.com' },
    status: 'completed' as const,
    success: true,
    displayMode: 'standard' as const,
    output:
      'Title: Example Domain\nURL: https://example.com\n\n## Table of Contents\n\n* [Header](#header)\n\n---\n\nMarkdown content here',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  expect(output.includes('[WEB FETCH]')).toBe(true);
  expect(output.includes('Example Domain')).toBe(true);
  expect(output.includes('https://example.com')).toBe(true);
  expect(output.includes('Table of Contents')).toBe(true);
  expect(output.includes('Markdown content here')).toBe(true);
});

it('CommandMessage renders ask_user concise single question when running', async () => {
  const clock = createFakeTimerClock();
  const props = {
    command: 'ask_user',
    toolName: 'ask_user',
    toolArgs: {
      questions: [{ question: 'What is your favorite color?' }],
    },
    status: 'running' as const,
    displayMode: 'concise' as const,
  };

  let lastFrame: (() => string | undefined) | undefined;
  try {
    ({ lastFrame } = await renderInAct(<CommandMessage {...props} />));
    await advanceClockInAct(clock, 1100);

    const output = stripAnsi(lastFrame?.() ?? '');

    expect(output.includes('▶')).toBe(true);
    expect(output.includes('Asked user "What is your favorite color?"')).toBe(true);
  } finally {
    clock.restore();
  }
});

it('CommandMessage renders ask_user concise multiple questions when running', async () => {
  const clock = createFakeTimerClock();
  const props = {
    command: 'ask_user',
    toolName: 'ask_user',
    toolArgs: {
      questions: [{ question: 'Color?' }, { question: 'Name?' }],
    },
    status: 'running' as const,
    displayMode: 'concise' as const,
  };

  let lastFrame: (() => string | undefined) | undefined;
  try {
    ({ lastFrame } = await renderInAct(<CommandMessage {...props} />));
    await advanceClockInAct(clock, 1100);

    const output = stripAnsi(lastFrame?.() ?? '');

    expect(output.includes('▶')).toBe(true);
    expect(output.includes('Asked user ["Color?, Name?"]')).toBe(true);
  } finally {
    clock.restore();
  }
});

it('CommandMessage renders ask_user answer in second line in concise mode when completed', async () => {
  const props = {
    command: 'ask_user',
    toolName: 'ask_user',
    toolArgs: {
      questions: [{ question: 'What is your favorite color?' }],
    },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'Question: What is your favorite color?\nAnswer: Red',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  const lines = output.trim().split('\n');
  expect(lines.length >= 2).toBe(true);
  expect(lines[0]!.includes('✔')).toBe(true);
  expect(lines[0]!.includes('Asked user "What is your favorite color?"')).toBe(true);
  expect(lines[1]!.includes('Response: Red')).toBe(true);
});

it('CommandMessage renders ask_user declined answer in second line in concise mode', async () => {
  const props = {
    command: 'ask_user',
    toolName: 'ask_user',
    toolArgs: {
      questions: [{ question: 'What is your favorite color?' }],
    },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'User declined to answer.',
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  const lines = output.trim().split('\n');
  expect(lines.length >= 2).toBe(true);
  expect(lines[0]!.includes('✔')).toBe(true);
  expect(lines[0]!.includes('Asked user "What is your favorite color?"')).toBe(true);
  expect(lines[1]!.includes('Response: User declined to answer.')).toBe(true);
});

it('CommandMessage renders in a single, muted line when isSubagent is true', async () => {
  const props = {
    command: 'create_file "src/test.txt"',
    toolName: 'create_file',
    toolArgs: { path: 'src/test.txt', content: 'hello' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    isSubagent: true,
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  const lines = output.trim().split('\n');
  expect(lines.length, `Expected exactly 1 line, got: ${output}`).toBe(1);
  expect(lines[0]!.includes('✔')).toBe(true);
  expect(lines[0]!.includes('Created "src/test.txt"')).toBe(true);
});

it('CommandMessage renders failed command in a single, muted line when isSubagent is true', async () => {
  const props = {
    command: 'create_file "src/test.txt"',
    toolName: 'create_file',
    toolArgs: { path: 'src/test.txt', content: 'hello' },
    status: 'failed' as const,
    success: false,
    failureReason: 'Permission denied',
    displayMode: 'concise' as const,
    isSubagent: true,
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  const lines = output.trim().split('\n');
  expect(lines.length, `Expected exactly 1 line, got: ${output}`).toBe(1);
  expect(lines[0]!.includes('✖')).toBe(true);
  // Raw command text for failures instead of friendly verb
  expect(lines[0]!.includes('create_file "src/test.txt"')).toBe(true);
});

it('CommandMessage renders running command with ▶ when isSubagent is true', async () => {
  const props = {
    command: 'shell ls -la',
    toolName: 'shell',
    status: 'running' as const,
    displayMode: 'concise' as const,
    isSubagent: true,
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  const lines = output.trim().split('\n');
  expect(lines.length, `Expected exactly 1 line, got: ${output}`).toBe(1);
  expect(lines[0]!.includes('▶')).toBe(true);
});

it('CommandMessage renders pending command with ▶ when isSubagent is true', async () => {
  const props = {
    command: 'shell ls -la',
    toolName: 'shell',
    status: 'pending' as const,
    displayMode: 'concise' as const,
    isSubagent: true,
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  const lines = output.trim().split('\n');
  expect(lines.length, `Expected exactly 1 line, got: ${output}`).toBe(1);
  expect(lines[0]!.includes('▶')).toBe(true);
});

it('CommandMessage renders failed status without success/failureReason as ✖ when isSubagent is true', async () => {
  const props = {
    command: 'create_file "src/test.txt"',
    toolName: 'create_file',
    toolArgs: { path: 'src/test.txt', content: 'hello' },
    status: 'failed' as const,
    displayMode: 'concise' as const,
    isSubagent: true,
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  const lines = output.trim().split('\n');
  expect(lines.length, `Expected exactly 1 line, got: ${output}`).toBe(1);
  expect(lines[0]!.includes('✖')).toBe(true);
});

it('CommandMessage renders approval rejection with ✖ when isSubagent is true', async () => {
  const props = {
    command: 'shell rm -rf /',
    toolName: 'shell',
    status: 'completed' as const,
    displayMode: 'concise' as const,
    isApprovalRejection: true,
    isSubagent: true,
  };

  const { lastFrame } = await renderInAct(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  const lines = output.trim().split('\n');
  expect(lines.length, `Expected exactly 1 line, got: ${output}`).toBe(1);
  expect(lines[0]!.includes('✖')).toBe(true);
});
