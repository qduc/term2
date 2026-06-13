// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import CommandMessage from './CommandMessage.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';

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

test('CommandMessage renders apply_patch line counts in concise mode', async (t) => {
  const props = {
    command: 'apply_patch update_file src/file.ts',
    toolName: TOOL_NAME_APPLY_PATCH,
    toolArgs: { path: 'src/file.ts', diff: ' context\n-old line\n+new line\n', type: 'update_file' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  t.true(output.includes('Patched update_file src/file.ts'), `Expected concise command: ${output}`);
  t.true(output.includes('(+1 -1)'), `Expected change counts in concise output: ${output}`);
});

test('CommandMessage renders search_replace line counts in concise mode', async (t) => {
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

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  t.true(output.includes('Edited'), `Expected concise tool name: ${output}`);
  t.true(output.includes('"src/file.ts"'), `Expected path in concise output: ${output}`);
  t.false(output.includes('hello'), `Expected search content to be hidden in concise output: ${output}`);
  t.false(output.includes('world'), `Expected replace content to be hidden in concise output: ${output}`);
  t.true(output.includes('(+1 -1)'), `Expected change counts in concise output: ${output}`);
});

test('CommandMessage renders search_replace multiple replacements in concise mode', async (t) => {
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

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  t.true(output.includes('Edited'), `Expected concise tool name: ${output}`);
  t.true(output.includes('"src/file.ts" (+ 1 more)'), `Expected path and count in concise output: ${output}`);
  t.false(output.includes('hello'), `Expected search content to be hidden in concise output: ${output}`);
  t.false(output.includes('world'), `Expected replace content to be hidden in concise output: ${output}`);
  t.true(output.includes('(+2 -2)'), `Expected change counts in concise output: ${output}`);
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

test('CommandMessage renders successfully completed shell command on a single line in concise mode', async (t) => {
  const props = {
    command: 'npm test',
    toolName: 'shell',
    toolArgs: { command: 'npm test' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'All tests passed\nOK',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('✔'), `Expected success icon in output: ${output}`);
  t.true(output.includes('$ npm test'), `Expected command in output: ${output}`);
  t.false(output.includes('All tests passed'), `Expected stdout to be hidden in output: ${output}`);
});

test('CommandMessage renders running shell command on a single line in concise mode', async (t) => {
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
    await act(async () => {
      ({ lastFrame } = render(<CommandMessage {...props} />));
      clock.advanceBy(1100);
    });

    const output = lastFrame?.() ?? '';

    t.true(output.includes('▶'), `Expected running icon in output: ${output}`);
    t.true(output.includes('$ npm run dev'), `Expected command in output: ${output}`);
  } finally {
    clock.restore();
  }
});

test('CommandMessage renders failed command on two lines in concise mode', async (t) => {
  const props = {
    command: 'npm test',
    toolName: 'shell',
    toolArgs: { command: 'npm test' },
    status: 'completed' as const,
    success: false,
    displayMode: 'concise' as const,
    failureReason: 'Test suite failed',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  // Expect two lines
  const lines = output.trim().split('\n');
  t.true(lines.length >= 2, `Expected at least 2 lines of output, got: ${output}`);
  t.true(lines[0]!.includes('✖'), `Expected fail icon on line 1: ${lines[0]}`);
  t.true(lines[0]!.includes('$ npm test'), `Expected command on line 1: ${lines[0]}`);
  t.true(output.includes('Test suite failed'), `Expected error message: ${output}`);
});

test('CommandMessage renders non-shell tool concisely on a single line', async (t) => {
  const props = {
    command: 'create_file',
    toolName: 'create_file',
    toolArgs: { path: 'src/new-file.ts', content: 'console.log("hello");' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('✔'), `Expected success icon in output: ${output}`);
  t.true(output.includes('Created'), `Expected tool name: ${output}`);
  t.true(output.includes('src/new-file.ts'), `Expected file path: ${output}`);
  t.false(output.includes('console.log'), `Expected content diff to be hidden: ${output}`);
});

test('CommandMessage renders grep case-insensitive flag in concise mode', async (t) => {
  const props = {
    command: 'grep',
    toolName: 'grep',
    toolArgs: { pattern: 'hello', path: 'source', case_sensitive: false },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('Searched'), `Expected tool name: ${output}`);
  t.true(output.includes('--ignore-case'), `Expected case-insensitive flag in output: ${output}`);
});

test('CommandMessage shows match count for grep tool in concise mode', async (t) => {
  const props = {
    command: 'grep',
    toolName: 'grep',
    toolArgs: { pattern: 'hello', path: 'source' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'file1.ts:1:hello\nfile2.ts:3:hello world\nfile3.ts:7:hello',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('(3 matches)'), `Expected match count in output: ${output}`);
});

test('CommandMessage shows singular match count for grep with 1 result', async (t) => {
  const props = {
    command: 'grep',
    toolName: 'grep',
    toolArgs: { pattern: 'hello', path: 'source' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'file1.ts:1:hello',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('(1 match)'), `Expected singular match count in output: ${output}`);
  t.false(output.includes('matches'), `Expected no plural 'matches' in output: ${output}`);
});

test('CommandMessage shows match count for find_files tool in concise mode', async (t) => {
  const props = {
    command: 'find_files',
    toolName: 'find_files',
    toolArgs: { pattern: '*.ts', path: 'source' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'source/a.ts\nsource/b.ts\nsource/c.ts\nsource/d.ts\nsource/e.ts',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('(5 matches)'), `Expected match count in output: ${output}`);
});

test('CommandMessage shows match count for shell grep command in concise mode', async (t) => {
  const props = {
    command: 'grep -rn hello source/',
    toolName: 'shell',
    toolArgs: { command: 'grep -rn hello source/' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'source/a.ts:1:hello\nsource/b.ts:3:hello',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('(2 matches)'), `Expected match count in output: ${output}`);
});

test('CommandMessage shows match count for shell rg command in concise mode', async (t) => {
  const props = {
    command: 'rg hello source/',
    toolName: 'shell',
    toolArgs: { command: 'rg hello source/' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'source/a.ts\n1:hello\n\nsource/b.ts\n3:hello world',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('(4 matches)'), `Expected match count in output: ${output}`);
});

test('CommandMessage suppresses rg stderr and keeps the match count in concise mode', async (t) => {
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

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  t.true(output.includes('(1 match)'), `Expected match count in output: ${output}`);
  t.false(output.includes('rg: source/missing.ts'), `Expected rg stderr to be suppressed: ${output}`);
  t.true(output.includes('source/a.ts:1:hello'), `Expected remaining search output in error message: ${output}`);
});

test('CommandMessage shows match count for shell find command in concise mode', async (t) => {
  const props = {
    command: 'find . -name *.ts',
    toolName: 'shell',
    toolArgs: { command: 'find . -name *.ts' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: './a.ts\n./b.ts\n./c.ts',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('(3 matches)'), `Expected match count in output: ${output}`);
});

test('CommandMessage shows match count for shell fd command in concise mode', async (t) => {
  const props = {
    command: 'fd test.ts',
    toolName: 'shell',
    toolArgs: { command: 'fd test.ts' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'source/test.ts\nsource/components/test.ts',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('(2 matches)'), `Expected match count in output: ${output}`);
});

test('CommandMessage does not show match count for non-search shell command in concise mode', async (t) => {
  const props = {
    command: 'npm test',
    toolName: 'shell',
    toolArgs: { command: 'npm test' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'All tests passed\nOK',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.false(output.includes('match'), `Expected no match count in output: ${output}`);
});

test('CommandMessage renders grep results grouped by file in standard mode', async (t) => {
  const props = {
    command: 'grep',
    toolName: 'grep',
    toolArgs: { pattern: 'hello', path: 'source' },
    status: 'completed' as const,
    success: true,
    displayMode: 'standard' as const,
    output: 'file1.ts:1:hello\nfile2.ts:3:hello',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('file1.ts'), `Expected file1.ts in output: ${output}`);
  t.true(output.includes('file2.ts'), `Expected file2.ts in output: ${output}`);
  t.true(output.includes('GREP RESULTS'), `Expected GREP RESULTS header in output: ${output}`);
});

test('CommandMessage does not show match count when output is empty', async (t) => {
  const props = {
    command: 'grep',
    toolName: 'grep',
    toolArgs: { pattern: 'nonexistent', path: 'source' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: '',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.false(output.includes('match'), `Expected no match count for empty output: ${output}`);
});

test('CommandMessage does not show match count when output is "No matches found."', async (t) => {
  const props = {
    command: 'grep',
    toolName: 'grep',
    toolArgs: { pattern: 'nonexistent', path: 'source' },
    status: 'completed' as const,
    success: true,
    displayMode: 'concise' as const,
    output: 'No matches found.',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = lastFrame() ?? '';

  t.false(output.includes('match'), `Expected no match count for "No matches found.": ${output}`);
});

test('CommandMessage truncates error message in concise mode when error is longer than 4 lines', async (t) => {
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

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  // Should show first 3 lines
  t.true(output.includes('Error line 1'), `Expected first line in output: ${output}`);
  t.true(output.includes('Error line 2'), `Expected second line in output: ${output}`);
  t.true(output.includes('Error line 3'), `Expected third line in output: ${output}`);
  // Should NOT show middle lines
  t.false(output.includes('Error line 4'), `Expected line 4 to be truncated: ${output}`);
  t.false(output.includes('Error line 5'), `Expected line 5 to be truncated: ${output}`);
  // Should show last line
  t.true(output.includes('Error line 6'), `Expected last line in output: ${output}`);
  // Should show truncation indicator
  t.true(output.includes('more lines'), `Expected 'more lines' indicator in output: ${output}`);
});

test('CommandMessage renders read_file with line numbers in standard mode', async (t) => {
  const props = {
    command: 'read_file',
    toolName: 'read_file',
    toolArgs: { path: 'src/main.ts', start_line: 1, end_line: 2 },
    status: 'completed' as const,
    success: true,
    displayMode: 'standard' as const,
    output: 'File: src/main.ts (2 lines) [lines 1-2]\n===\nimport { foo } from "bar";\nfoo();',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  t.true(output.includes('[READ FILE]'), `Expected header: ${output}`);
  t.true(output.includes('src/main.ts'), `Expected file path: ${output}`);
  t.true(output.includes('1 │ import { foo } from "bar";'), `Expected first line with number: ${output}`);
  t.true(output.includes('2 │ foo();'), `Expected second line with number: ${output}`);
});

test('CommandMessage renders find_files lists in standard mode', async (t) => {
  const props = {
    command: 'find_files',
    toolName: 'find_files',
    toolArgs: { pattern: '*.ts' },
    status: 'completed' as const,
    success: true,
    displayMode: 'standard' as const,
    output: 'src/a.ts\nsrc/b.ts',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  t.true(output.includes('[FILE SEARCH]'), `Expected header: ${output}`);
  t.true(output.includes('📄 src/a.ts'), `Expected file 1: ${output}`);
  t.true(output.includes('📄 src/b.ts'), `Expected file 2: ${output}`);
});

test('CommandMessage renders subagent card in standard mode', async (t) => {
  const props = {
    command: 'run_subagent',
    toolName: 'run_subagent',
    toolArgs: { role: 'worker', task: 'some task' },
    status: 'completed' as const,
    success: true,
    displayMode: 'standard' as const,
    output: 'Status: completed\nTools used: shell(3)\nFiles changed: src/a.ts\n\nSubagent finished successfully!',
  };

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  t.true(output.includes('[SUBAGENT]'), `Expected header: ${output}`);
  t.true(output.includes('worker'), `Expected subagent role: ${output}`);
  t.true(output.includes('COMPLETED'), `Expected status: ${output}`);
  t.true(output.includes('Tools: shell(3)'), `Expected tools summary: ${output}`);
  t.true(output.includes('Changed: src/a.ts'), `Expected files summary: ${output}`);
  t.true(output.includes('Subagent finished successfully!'), `Expected main text: ${output}`);
});

test('CommandMessage renders web_search dashboard in standard mode', async (t) => {
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

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  t.true(output.includes('[WEB SEARCH]'), `Expected header: ${output}`);
  t.true(output.includes('Answer Summary'), `Expected answer card header: ${output}`);
  t.true(output.includes('Ink is a React renderer.'), `Expected answer: ${output}`);
  t.true(output.includes('1. Ink GitHub'), `Expected result title: ${output}`);
  t.true(output.includes('https://github.com/vadimdemedes/ink'), `Expected result URL: ${output}`);
  t.true(output.includes('React for CLI.'), `Expected result snippet: ${output}`);
});

test('CommandMessage renders web_fetch result in standard mode', async (t) => {
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

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  t.true(output.includes('[WEB FETCH]'), `Expected header: ${output}`);
  t.true(output.includes('Example Domain'), `Expected title: ${output}`);
  t.true(output.includes('https://example.com'), `Expected URL: ${output}`);
  t.true(output.includes('Table of Contents'), `Expected TOC header: ${output}`);
  t.true(output.includes('Markdown content here'), `Expected content: ${output}`);
});

test('CommandMessage renders ask_user concise single question when running', async (t) => {
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
    await act(async () => {
      ({ lastFrame } = render(<CommandMessage {...props} />));
      clock.advanceBy(1100);
    });

    const output = stripAnsi(lastFrame?.() ?? '');

    t.true(output.includes('▶'), `Expected running icon: ${output}`);
    t.true(
      output.includes('Asked user "What is your favorite color?"'),
      `Expected single question in output: ${output}`,
    );
  } finally {
    clock.restore();
  }
});

test('CommandMessage renders ask_user concise multiple questions when running', async (t) => {
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
    await act(async () => {
      ({ lastFrame } = render(<CommandMessage {...props} />));
      clock.advanceBy(1100);
    });

    const output = stripAnsi(lastFrame?.() ?? '');

    t.true(output.includes('▶'), `Expected running icon: ${output}`);
    t.true(output.includes('Asked user ["Color?, Name?"]'), `Expected multiple questions preview: ${output}`);
  } finally {
    clock.restore();
  }
});

test('CommandMessage renders ask_user answer in second line in concise mode when completed', async (t) => {
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

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  const lines = output.trim().split('\n');
  t.true(lines.length >= 2, `Expected at least 2 lines, got: ${output}`);
  t.true(lines[0]!.includes('✔'), `Expected checkmark on line 1: ${lines[0]}`);
  t.true(lines[0]!.includes('Asked user "What is your favorite color?"'), `Expected question on line 1: ${lines[0]}`);
  t.true(lines[1]!.includes('Response: Red'), `Expected response on line 2: ${lines[1]}`);
});

test('CommandMessage renders ask_user declined answer in second line in concise mode', async (t) => {
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

  const { lastFrame } = render(<CommandMessage {...props} />);
  const output = stripAnsi(lastFrame() ?? '');

  const lines = output.trim().split('\n');
  t.true(lines.length >= 2, `Expected at least 2 lines, got: ${output}`);
  t.true(lines[0]!.includes('✔'), `Expected checkmark on line 1: ${lines[0]}`);
  t.true(lines[0]!.includes('Asked user "What is your favorite color?"'), `Expected question on line 1: ${lines[0]}`);
  t.true(lines[1]!.includes('Response: User declined to answer.'), `Expected response on line 2: ${lines[1]}`);
});
