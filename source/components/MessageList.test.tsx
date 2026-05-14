import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import MessageList, { splitStaticHistory } from './MessageList.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';

const countOccurrences = (text, pattern) => text.split(pattern).length - 1;
const stripAnsi = (text: string) => text.replaceAll(/\u001B\[[0-9;]*m/g, '');
const firstTableBorder = (text: string) =>
  stripAnsi(text)
    .split('\n')
    .find((line) => line.trimStart().startsWith('+')) ?? '';
const renderedLines = (text: string) => stripAnsi(text).trim().split('\n');

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

test('MessageList renders image attachment summaries without leaked sentinel ids', (t) => {
  const messages = [
    {
      id: 1,
      sender: 'user',
      text: 'Tell me what you see\n[1 image attached]',
    },
  ];

  const { lastFrame } = render(<MessageList messages={messages} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('❯ Tell me what you see'));
  t.true(output.includes('[1 image attached]'));
  t.false(output.includes('f9uatvt88vql1'));
});

test('MessageList retains static history across rerenders', (t) => {
  const renderer = render(<MessageList messages={[{ id: 'one', sender: 'bot', text: 'one' }]} />);
  renderer.rerender(
    <MessageList
      messages={[
        { id: 'one', sender: 'bot', text: 'one' },
        { id: 'two', sender: 'bot', text: 'two' },
      ]}
    />,
  );

  const output = renderer.lastFrame() ?? '';
  t.true(output.includes('one'));
  t.true(output.includes('two'));
});

test('MessageList appends a fresh startup banner after clearing conversation history', (t) => {
  const settingsService = createMockSettingsService();
  const renderer = render(
    <MessageList
      messages={[{ id: 'one', sender: 'bot', text: 'one' }]}
      bannerItems={['startup-banner-0']}
      settingsService={settingsService}
    />,
  );

  renderer.rerender(
    <MessageList
      messages={[]}
      bannerItems={['startup-banner-0', 'startup-banner-1']}
      settingsService={settingsService}
    />,
  );

  const output = renderer.lastFrame() ?? '';
  t.is(countOccurrences(output, 'term²'), 2);
});

test('MessageList moves a message from active to static without duplicating it', (t) => {
  const renderer = render(
    <MessageList
      messages={[
        { id: 'before', sender: 'bot', text: 'before' },
        { id: 'running-command', sender: 'command', status: 'running', command: 'npm test', output: '' },
      ]}
    />,
  );

  renderer.rerender(
    <MessageList
      messages={[
        { id: 'before', sender: 'bot', text: 'before' },
        { id: 'running-command', sender: 'command', status: 'completed', command: 'npm test', output: '' },
      ]}
    />,
  );

  const output = renderer.lastFrame() ?? '';
  t.is(countOccurrences(output, 'before'), 1);
  t.is(countOccurrences(output, 'npm test'), 1);
});

test('MessageList renders active and static markdown tables with the same padded width', (t) => {
  const markdown = `| File | Change |
| --- | --- |
| \`openai-compatible/model.ts\` | Track \`reasoningContent\` separately from \`reasoning\`; emit both \`reasoning_content\` and \`providerData\` in messages and function_calls; accumulate \`reasoning_content\` delta in streams |`;

  const renderer = render(
    <MessageList messages={[{ id: 'table', sender: 'bot', status: 'streaming', text: markdown }]} />,
  );
  const activeBorder = firstTableBorder(renderer.lastFrame() ?? '');

  renderer.rerender(<MessageList messages={[{ id: 'table', sender: 'bot', status: 'finalized', text: markdown }]} />);
  const staticBorder = firstTableBorder(renderer.lastFrame() ?? '');

  t.regex(activeBorder, /^ {2,}\+/);
  t.is(staticBorder, activeBorder);
});

test('MessageList renders active and static wrapped text with the same line breaks', (t) => {
  const text =
    'This paragraph is intentionally long enough to wrap near the terminal boundary while the message is streaming and must keep the same wrapped shape after it is finalized.';

  const renderer = render(<MessageList messages={[{ id: 'paragraph', sender: 'bot', status: 'streaming', text }]} />);
  const activeLines = renderedLines(renderer.lastFrame() ?? '');

  renderer.rerender(<MessageList messages={[{ id: 'paragraph', sender: 'bot', status: 'finalized', text }]} />);
  const staticLines = renderedLines(renderer.lastFrame() ?? '');

  t.true(activeLines.length > 1);
  t.deepEqual(staticLines, activeLines);
});

test('splitStaticHistory keeps running command messages active regardless of position', (t) => {
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

  const { history, active } = splitStaticHistory(messages);

  t.false(history.some((message) => message.id === 'running-command'));
  t.true(active.some((message) => message.id === 'running-command'));
  // Only the prefix before the running command can be static without reordering output.
  t.true(history.some((message) => message.id === 'msg-0'));
  t.true(active.some((message) => message.id === 'tail-24'));
});

test('splitStaticHistory keeps unfinalized reasoning messages and following messages active', (t) => {
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

  const { history, active } = splitStaticHistory(messages);

  t.true(history.some((message) => message.id === 'msg-0'));
  t.true(active.some((message) => message.id === 'tail-24'));
  t.false(history.some((message) => message.id === 'reasoning-message'));
  t.true(active.some((message) => message.id === 'reasoning-message'));
});

test('splitStaticHistory keeps streaming bot messages and following messages active', (t) => {
  const messages = [
    { id: 'before', sender: 'bot', text: 'before', status: 'finalized' },
    { id: 'streaming-bot', sender: 'bot', text: 'partial', status: 'streaming' },
    { id: 'after', sender: 'bot', text: 'after', status: 'finalized' },
  ];

  const { history, active } = splitStaticHistory(messages);

  t.deepEqual(
    history.map((message) => message.id),
    ['before'],
  );
  t.deepEqual(
    active.map((message) => message.id),
    ['streaming-bot', 'after'],
  );
});

test('splitStaticHistory moves finalized bot messages to static history', (t) => {
  const messages = [
    { id: 'first', sender: 'bot', text: 'first', status: 'finalized' },
    { id: 'second', sender: 'bot', text: 'second', status: 'finalized' },
  ];

  const { history, active } = splitStaticHistory(messages);

  t.deepEqual(
    history.map((message) => message.id),
    ['first', 'second'],
  );
  t.deepEqual(active, []);
});

test('splitStaticHistory preserves chronological order after the first active message', (t) => {
  const messages = [
    { id: 'before', sender: 'bot', text: 'before' },
    {
      id: 'running-command',
      sender: 'command',
      status: 'running',
      command: 'npm test',
      output: '',
    },
    {
      id: 'completed-command',
      sender: 'command',
      status: 'completed',
      command: 'pwd',
      output: '/tmp',
    },
    { id: 'after', sender: 'bot', text: 'after' },
  ];

  const { history, active } = splitStaticHistory(messages);

  t.deepEqual(
    history.map((message) => message.id),
    ['before'],
  );
  t.deepEqual(
    active.map((message) => message.id),
    ['running-command', 'completed-command', 'after'],
  );
});

test('splitStaticHistory moves finalized reasoning messages to static history', (t) => {
  const messages = [
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `msg-${index}`,
      sender: 'bot',
      text: `message ${index}`,
    })),
    {
      id: 'finalized-reasoning',
      sender: 'reasoning',
      status: 'finalized',
      text: 'stable paragraph',
    },
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `tail-${index}`,
      sender: 'bot',
      text: `tail ${index}`,
    })),
  ];

  const { history, active } = splitStaticHistory(messages);

  t.true(history.some((message) => message.id === 'finalized-reasoning'));
  t.false(active.some((message) => message.id === 'finalized-reasoning'));
  t.is(active.length, 0);
});
