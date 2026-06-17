// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import ChatMessage from './ChatMessage.js';

const stripAnsi = (s: string) => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

it('ChatMessage renders reasoning messages with Markdown formatting', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(
      <ChatMessage
        msg={{
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
