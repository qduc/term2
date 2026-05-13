import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import ChatMessage from '../../dist/components/ChatMessage.js';

const stripAnsi = (s) => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

test('ChatMessage renders reasoning messages with Markdown formatting', (t) => {
  const { lastFrame } = render(
    React.createElement(ChatMessage, {
      msg: {
        sender: 'reasoning',
        text: 'Checking **constraints** before `editing`.',
      },
    }),
  );

  const frame = stripAnsi(lastFrame() || '');
  t.true(frame.includes('Checking'));
  t.true(frame.includes('constraints'));
  t.true(frame.includes('editing'));
  t.false(frame.includes('**constraints**'));
  t.false(frame.includes('`editing`'));
});
