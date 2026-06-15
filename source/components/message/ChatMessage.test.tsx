// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import ChatMessage from './ChatMessage.js';

const stripAnsi = (s: string) => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

test('ChatMessage renders reasoning messages with Markdown formatting', async (t) => {
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
  t.true(frame.includes('Checking'));
  t.true(frame.includes('constraints'));
  t.true(frame.includes('editing'));
  t.false(frame.includes('**constraints**'));
  t.false(frame.includes('`editing`'));

  await act(async () => {
    unmount();
  });
});
