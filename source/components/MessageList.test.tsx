import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import MessageList, { splitStaticHistory, shouldCommitMessageToStatic } from './MessageList.js';
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

test('MessageList commits restored finalized messages to Static on initial render', (t) => {
  const renderer = render(
    <MessageList
      messages={[{ id: 'restored-bot', sender: 'bot', status: 'finalized', text: 'restored answer' }]}
      restoredStaticMessageIds={['restored-bot']}
    />,
  );

  const output = renderer.lastFrame() ?? '';
  // Ink writes <Static> items separately from the live frame; dynamic-only
  // rendering produces a single frame for this input.
  t.true(renderer.frames.length > 1);
  t.true(output.includes('restored answer'));
});

test('MessageList updates static history when a message with the same id is corrected', (t) => {
  const renderer = render(
    <MessageList messages={[{ id: 'corrected-message', sender: 'bot', status: 'finalized', text: 'Hello wrold' }]} />,
  );

  renderer.rerender(
    <MessageList messages={[{ id: 'corrected-message', sender: 'bot', status: 'finalized', text: 'Hello world' }]} />,
  );

  const output = renderer.lastFrame() ?? '';
  t.true(output.includes('Hello world'));
  t.false(output.includes('Hello wrold'));
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
  t.false(output.includes('one'));
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

test('MessageList moves a completed command before active reasoning directly into static history', (t) => {
  const renderer = render(
    <MessageList
      messages={[{ id: 'running-command', sender: 'command', status: 'running', command: 'npm test', output: '' }]}
    />,
  );

  renderer.rerender(
    <MessageList
      messages={[
        { id: 'running-command', sender: 'command', status: 'completed', command: 'npm test', output: 'passed' },
        { id: 'active-reasoning', sender: 'reasoning', text: 'thinking' },
      ]}
    />,
  );

  const output = renderer.lastFrame() ?? '';
  t.is(countOccurrences(output, 'npm test'), 1);
  t.is(countOccurrences(output, 'thinking'), 1);
});

test('MessageList preserves spaces in bot text immediately before a command message', (t) => {
  const messages = [
    {
      id: 'before-tool',
      sender: 'bot',
      status: 'finalized',
      text: 'I will read this file:',
    },
    {
      id: 'read-file-call',
      sender: 'command',
      status: 'running',
      command: 'source/components/MessageList.tsx',
      output: '',
      toolName: 'read_file',
      toolArgs: { path: 'source/components/MessageList.tsx' },
    },
  ];

  const { lastFrame } = render(<MessageList messages={messages} />);
  const output = stripAnsi(lastFrame() ?? '');

  t.true(output.includes('read this file:'));
  t.false(output.includes('read thisfile:'));
});

test('MessageList renders a compact subagent activity peek', (t) => {
  const messages = [
    {
      id: 'subagent-agent-1',
      sender: 'subagent',
      status: 'running',
      agentId: 'agent-1',
      role: 'explorer',
      task: 'inspect the command message rendering flow and report findings that are quite long',
      tools: ['grep', 'read_file', 'read_code_outline'],
    },
  ];

  const { lastFrame } = render(<MessageList messages={messages} />);
  const output = stripAnsi(lastFrame() ?? '');

  t.true(output.includes('grep'));
  t.true(output.includes('read_file'));
  t.true(output.includes('read_code_outline'));
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

test('shouldCommitMessageToStatic commits restored finalized history immediately on first render', (t) => {
  t.true(
    shouldCommitMessageToStatic({
      hasActiveMessages: false,
      hasExistingStaticHistory: false,
      wasPreviouslyActive: false,
      hasPendingCandidateSignature: false,
      isRestoredMessage: true,
    }),
  );
});

test('shouldCommitMessageToStatic keeps fresh finalized messages deferred on first render', (t) => {
  t.false(
    shouldCommitMessageToStatic({
      hasActiveMessages: false,
      hasExistingStaticHistory: false,
      wasPreviouslyActive: false,
      hasPendingCandidateSignature: false,
      isRestoredMessage: false,
    }),
  );
});

test('shouldCommitMessageToStatic commits completed commands immediately on first render', (t) => {
  t.true(
    shouldCommitMessageToStatic({
      hasActiveMessages: false,
      hasExistingStaticHistory: false,
      wasPreviouslyActive: false,
      hasPendingCandidateSignature: false,
      isRestoredMessage: false,
      isCompletedCommand: true,
    }),
  );
});

test('MessageList commits a first-seen completed command directly to Static', (t) => {
  const renderer = render(
    <MessageList
      messages={[{ id: 'done-command', sender: 'command', status: 'completed', command: 'pwd', output: '/repo' }]}
    />,
  );

  t.true(renderer.frames.length > 1);
  t.true((renderer.lastFrame() ?? '').includes('/repo'));
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

test('splitStaticHistory keeps completed commands behind an earlier running command active', (t) => {
  const messages = [
    { id: 'older', sender: 'bot', text: 'older', status: 'finalized' },
    { id: 'running-command', sender: 'command', status: 'running', command: 'npm test', output: '' },
    { id: 'completed-command', sender: 'command', status: 'completed', command: 'pwd', output: '/repo' },
  ];

  const { history, active } = splitStaticHistory(messages);

  t.true(active.some((message) => message.id === 'running-command'));
  t.true(active.some((message) => message.id === 'completed-command'));
  t.false(history.some((message) => message.id === 'completed-command'));
});

test('splitStaticHistory keeps bot text before a running command active', (t) => {
  const messages = [
    { id: 'older', sender: 'bot', text: 'older', status: 'finalized' },
    { id: 'before-tool', sender: 'bot', text: 'I will read this file:', status: 'finalized' },
    {
      id: 'running-command',
      sender: 'command',
      status: 'running',
      command: 'read_file "source/components/MessageList.tsx"',
      output: '',
    },
  ];

  const { history, active } = splitStaticHistory(messages);

  t.deepEqual(
    history.map((message) => message.id),
    ['older'],
  );
  t.deepEqual(
    active.map((message) => message.id),
    ['before-tool', 'running-command'],
  );
});

test('splitStaticHistory keeps reasoning before a running command active', (t) => {
  const messages = [
    { id: 'older', sender: 'bot', text: 'older', status: 'finalized' },
    { id: 'before-tool', sender: 'reasoning', text: 'I need to inspect the file.', status: 'finalized' },
    {
      id: 'running-command',
      sender: 'command',
      status: 'running',
      command: 'read_file "source/components/MessageList.tsx"',
      output: '',
    },
  ];

  const { history, active } = splitStaticHistory(messages);

  t.deepEqual(
    history.map((message) => message.id),
    ['older'],
  );
  t.deepEqual(
    active.map((message) => message.id),
    ['before-tool', 'running-command'],
  );
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

test('MessageList continuation across static-dynamic boundary has correct spacing', (t) => {
  const messages = [
    { id: 'chunk-1', sender: 'bot', status: 'finalized', text: '## Heading\n\n' },
    { id: 'chunk-2', sender: 'bot', status: 'streaming', text: 'Paragraph' },
  ];
  const { lastFrame } = render(<MessageList messages={messages} />);
  const lines = renderedLines(lastFrame() ?? '');
  const headingIndex = lines.findIndex((line) => line.includes('## Heading'));
  const paragraphIndex = lines.findIndex((line) => line.includes('Paragraph'));
  t.true(headingIndex !== -1);
  t.true(paragraphIndex !== -1);
  // Exactly one blank line between heading and paragraph (markdown spacing only)
  t.is(paragraphIndex - headingIndex, 2);
});

test('MessageList continuation within dynamic items has correct spacing', (t) => {
  const messages = [
    { id: 'chunk-1', sender: 'bot', status: 'streaming', text: '## Heading\n\n' },
    { id: 'chunk-2', sender: 'bot', status: 'streaming', text: 'Paragraph' },
  ];
  const { lastFrame } = render(<MessageList messages={messages} />);
  const lines = renderedLines(lastFrame() ?? '');
  const headingIndex = lines.findIndex((line) => line.includes('## Heading'));
  const paragraphIndex = lines.findIndex((line) => line.includes('Paragraph'));
  t.true(headingIndex !== -1);
  t.true(paragraphIndex !== -1);
  // Exactly one blank line between heading and paragraph (markdown spacing only)
  t.is(paragraphIndex - headingIndex, 2);
});

test('MessageList non-continuation across static-dynamic boundary has correct spacing', (t) => {
  const messages = [
    { id: 'user-msg', sender: 'user', text: 'hello', status: 'finalized' },
    { id: 'bot-msg', sender: 'bot', text: 'Paragraph', status: 'streaming' },
  ];
  const { lastFrame } = render(<MessageList messages={messages} />);
  const lines = renderedLines(lastFrame() ?? '');
  const userIndex = lines.findIndex((line) => line.includes('❯ hello'));
  const botIndex = lines.findIndex((line) => line.includes('Paragraph'));
  t.true(userIndex !== -1);
  t.true(botIndex !== -1);
  // Exactly one blank line between user and bot (marginTop spacing only)
  t.is(botIndex - userIndex, 2);
});

test('MessageList does not strand blank lines mid-history when reasoning streams in chunks', (t) => {
  // Reproduces the chunked-reasoning trigger: a finalized chunk is briefly the
  // last item with no dynamic tail (a safe boundary landed at the end of the
  // buffer, so no live tail was pushed), then reasoning resumes and more
  // chunks are appended. The trailing spacer must not get frozen into the
  // write-once static buffer between the two chunks.
  const renderer = render(
    <MessageList
      messages={[
        { id: 'chunk-a', sender: 'reasoning', status: 'finalized', text: 'alpha reasoning chunk' },
        { id: 'tail', sender: 'reasoning', status: 'streaming', text: 'live tail' },
      ]}
    />,
  );

  // Boundary at end of buffer: the tail is finalized in place, no new tail.
  renderer.rerender(
    <MessageList
      messages={[
        { id: 'chunk-a', sender: 'reasoning', status: 'finalized', text: 'alpha reasoning chunk' },
        { id: 'tail', sender: 'reasoning', status: 'finalized', text: 'bravo reasoning chunk' },
      ]}
    />,
  );

  // Reasoning resumes and appends another chunk below the now-static history.
  renderer.rerender(
    <MessageList
      messages={[
        { id: 'chunk-a', sender: 'reasoning', status: 'finalized', text: 'alpha reasoning chunk' },
        { id: 'tail', sender: 'reasoning', status: 'finalized', text: 'bravo reasoning chunk' },
        { id: 'chunk-c', sender: 'reasoning', status: 'finalized', text: 'charlie reasoning chunk' },
        { id: 'tail-2', sender: 'reasoning', status: 'streaming', text: 'live tail two' },
      ]}
    />,
  );

  const lines = renderedLines(renderer.lastFrame() ?? '');
  const bravoIndex = lines.findIndex((line) => line.includes('bravo reasoning chunk'));
  const charlieIndex = lines.findIndex((line) => line.includes('charlie reasoning chunk'));

  t.true(bravoIndex !== -1);
  t.true(charlieIndex !== -1);
  // Exactly one blank line (non-continuation marginTop) between the two
  // reasoning chunks. The pre-fix bug baked an extra spacer Box below the
  // transiently-last 'bravo' chunk, producing a gap of 3.
  t.is(charlieIndex - bravoIndex, 2);
});

test('MessageList outputs a blank line after the final message in Static', (t) => {
  const messages = [{ id: 'static-msg', sender: 'bot', status: 'finalized', text: 'final static message' }];
  const { lastFrame } = render(<MessageList messages={messages} />);
  const output = lastFrame() ?? '';

  // Since the last message is finalized, it is output to Static.
  // It should end with a blank line because of the Box height={1} added inside renderStaticItem.
  const lines = output.split('\n');
  t.true(lines.length > 0);
  t.is(lines[lines.length - 1].trim(), '');
});

test('MessageList hides reasoning messages when displayMode is concise', (t) => {
  const mockSettingsService = {
    get: (key: string) => {
      if (key === 'ui.displayMode') return 'concise';
      return undefined;
    },
    onChange: () => () => {},
  } as any;

  const messages = [
    { id: '1', sender: 'user', text: 'Hello' },
    { id: '2', sender: 'reasoning', text: 'I am thinking about hello' },
    { id: '3', sender: 'bot', text: 'Hello back!' },
  ];

  const { lastFrame } = render(<MessageList messages={messages} settingsService={mockSettingsService} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('Hello'), `Expected user message: ${output}`);
  t.true(output.includes('Hello back!'), `Expected bot message: ${output}`);
  t.false(output.includes('thinking'), `Expected reasoning message to be hidden: ${output}`);
});

test('MessageList retains chronological order when active message is finalized in the same tick as a new finalized message that was never active', (t) => {
  const renderer = render(
    <MessageList messages={[{ id: 'list-msg', sender: 'bot', status: 'streaming', text: '- list item' }]} />,
  );

  renderer.rerender(
    <MessageList
      messages={[
        { id: 'heading-msg', sender: 'bot', status: 'finalized', text: '### Heading' },
        { id: 'list-msg', sender: 'bot', status: 'finalized', text: '- list item' },
      ]}
    />,
  );

  const output = stripAnsi(renderer.lastFrame() ?? '');
  const headingIndex = output.indexOf('### Heading');
  const listIndex = output.indexOf('list item');

  t.true(headingIndex !== -1, 'Heading should be present');
  t.true(listIndex !== -1, 'List item should be present');
  t.true(headingIndex < listIndex, `Heading should render before list item. Output was: \n${output}`);
});
