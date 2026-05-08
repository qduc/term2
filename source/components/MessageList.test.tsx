import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import MessageList, { splitStaticHistory } from './MessageList.js';

test('MessageList renders user and bot messages', (t) => {
  const messages = [
    { id: 1, sender: 'user', text: 'hello' },
    { id: 2, sender: 'bot', text: 'hi there' },
  ];
  const { lastFrame } = render(<MessageList messages={messages} />);
  const output = lastFrame() ?? '';
  t.true(output.includes('❯ hello'));
  t.true(output.includes('hi there'));
});

test('splitStaticHistory keeps running command messages active even when outside the count window', (t) => {
  const messages = [
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `msg-${index}`,
      sender: 'bot',
      text: `message ${index}`,
    })),
    {
      id: 'running-command',
      sender: 'command',
      status: 'running',
      command: 'npm test',
      output: '',
    },
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `tail-${index}`,
      sender: 'bot',
      text: `tail ${index}`,
    })),
  ];

  const { history, active } = splitStaticHistory(messages, 20);

  t.false(history.some((message) => message.id === 'running-command'));
  t.true(active.some((message) => message.id === 'running-command'));
});

test('splitStaticHistory keeps reasoning messages active while moving finalized overflow to history', (t) => {
  const messages = [
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `msg-${index}`,
      sender: 'bot',
      text: `message ${index}`,
    })),
    {
      id: 'reasoning-message',
      sender: 'reasoning',
      text: 'thinking',
    },
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `tail-${index}`,
      sender: 'bot',
      text: `tail ${index}`,
    })),
  ];

  const { history, active } = splitStaticHistory(messages, 20);

  t.true(history.some((message) => message.id === 'msg-0'));
  t.false(history.some((message) => message.id === 'reasoning-message'));
  t.true(active.some((message) => message.id === 'reasoning-message'));
});
