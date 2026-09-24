// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import chalk from 'chalk';
import ChatMessage from './ChatMessage.js';
import { COLOR_BORDER, COLOR_USER_BACKGROUND } from '../theme.js';

const stripAnsi = (s: string) => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

const hexToRgbEscape = (hex: string, code: 38 | 48 = 48) => {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `\u001B[${code};2;${r};${g};${b}m`;
};

it('ChatMessage renders reasoning messages with Markdown formatting', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(
      <ChatMessage
        msg={{
          id: 'reasoning-1',
          sender: 'reasoning',
          text: 'Checking **constraints** before `editing`.',
        }}
      />,
    );
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  const frame = stripAnsi(lastFrame() || '');
  expect(frame.includes('Checking')).toBe(true);
  expect(frame.includes('constraints')).toBe(true);
  expect(frame.includes('editing')).toBe(true);
  expect(frame.includes('**constraints**')).toBe(false);
  expect(frame.includes('`editing`')).toBe(false);

  await act(async () => {
    unmount();
  });
});

it('ChatMessage renders user messages with prompt marker', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(
      <ChatMessage
        msg={{
          id: 'user-1',
          sender: 'user',
          text: 'How do I run tests?',
        }}
      />,
    );
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  const frame = stripAnsi(lastFrame() || '');
  expect(frame.includes('❯ How do I run tests?')).toBe(true);

  await act(async () => {
    unmount();
  });
});

it('ChatMessage renders a rule presentation system message as a divider', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(
      <ChatMessage
        msg={{
          id: 'rule-1',
          sender: 'system',
          text: '',
          presentation: 'rule',
        }}
      />,
    );
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  const frame = stripAnsi(lastFrame() || '');
  // A divider is geometry, not text: only box-drawing characters, no prose.
  expect(frame.trim()).toMatch(/^─+$/);
  expect(frame.includes('─'.repeat(20))).toBe(true);

  await act(async () => {
    unmount();
  });
});

it('ChatMessage displays a memory injection receipt in the transcript', async () => {
  let frame = '';
  let unmount!: () => void;
  await act(async () => {
    const rendered = render(
      <ChatMessage
        msg={{ id: 'memory-1', sender: 'system', text: 'Loaded 1 memory: project / rule — Project rule' }}
      />,
    );
    frame = stripAnsi(rendered.lastFrame() || '');
    unmount = rendered.unmount;
  });
  expect(frame).toContain('Loaded 1 memory: project / rule — Project rule');
  await act(async () => unmount());
});

it('ChatMessage renders rule presentation using the border color token', async () => {
  // ink-testing-library's mock stdout disables colors at import time; raise
  // chalk's level so the frame carries the real ANSI attributes. Level 3 keeps
  // truecolor escapes, which the assertion below matches on.
  const originalLevel = chalk.level;
  chalk.level = 3;

  try {
    let lastFrame!: () => string | undefined;
    let unmount!: () => void;

    await act(async () => {
      const result = render(
        <ChatMessage
          msg={{
            id: 'rule-2',
            sender: 'system',
            text: '',
            presentation: 'rule',
          }}
        />,
      );
      lastFrame = result.lastFrame;
      unmount = result.unmount;
    });

    // Dividers are structural; they must not introduce a new color.
    expect((lastFrame() || '').includes(hexToRgbEscape(COLOR_BORDER, 38))).toBe(true);

    await act(async () => {
      unmount();
    });
  } finally {
    chalk.level = originalLevel;
  }
});

it('ChatMessage renders user messages on a background band', async () => {
  // ink-testing-library's mock stdout disables colors at import time; raise
  // chalk's level so the frame carries the real ANSI attributes. Level 3 keeps
  // truecolor escapes, which the assertion below matches on.
  const originalLevel = chalk.level;
  chalk.level = 3;

  try {
    let lastFrame!: () => string | undefined;
    let unmount!: () => void;

    await act(async () => {
      const result = render(
        <ChatMessage
          msg={{
            id: 'user-1',
            sender: 'user',
            text: 'How do I run tests?',
          }}
        />,
      );
      lastFrame = result.lastFrame;
      unmount = result.unmount;
    });

    // User messages carry the band background so they never read as another
    // accent-colored header line.
    const frame = lastFrame() || '';
    expect(frame.includes(hexToRgbEscape(COLOR_USER_BACKGROUND))).toBe(true);

    await act(async () => {
      unmount();
    });
  } finally {
    chalk.level = originalLevel;
  }
});
