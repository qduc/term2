// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import { renderInAct, rerenderInAct } from '../../test-helpers/ink-testing.js';
import MessageList, { splitStaticHistory, shouldCommitMessageToStatic } from './MessageList.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';

const countOccurrences = (text: string, pattern: string) => text.split(pattern).length - 1;
const stripAnsi = (text: string) => text.replaceAll(/\u001B\[[0-9;]*m/g, '');
const firstTableBorder = (text: string) =>
  stripAnsi(text)
    .split('\n')
    .find((line) => line.trimStart().startsWith('+')) ?? '';
const renderedLines = (text: string) => stripAnsi(text).trim().split('\n');

test.serial('MessageList renders user and bot messages', async (t) => {
  const messages = [
    { id: 1, sender: 'user', text: 'hello' },
    { id: 2, sender: 'bot', text: 'hi there' },
  ];
  const { lastFrame } = await renderInAct(<MessageList messages={messages} />, t);
  const output = lastFrame() ?? '';
  t.true(output.includes('❯ hello'));
  t.true(output.includes('hi there'));
});

test.serial('MessageList renders image attachment summaries without leaked sentinel ids', async (t) => {
  const messages = [
    {
      id: 1,
      sender: 'user',
      text: 'Tell me what you see\n[1 image attached]',
    },
  ];

  const { lastFrame } = await renderInAct(<MessageList messages={messages} />, t);
  const output = lastFrame() ?? '';

  t.true(output.includes('❯ Tell me what you see'));
  t.true(output.includes('[1 image attached]'));
  t.false(output.includes('f9uatvt88vql1'));
});

test.serial('MessageList retains static history across rerenders', async (t) => {
  const renderer = await renderInAct(<MessageList messages={[{ id: 'one', sender: 'bot', text: 'one' }]} />, t);
  await rerenderInAct(
    renderer,
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

test.serial('MessageList commits restored finalized messages to Static on initial render', async (t) => {
  const renderer = await renderInAct(
    <MessageList
      messages={[{ id: 'restored-bot', sender: 'bot', status: 'finalized', text: 'restored answer' }]}
      restoredStaticMessageIds={['restored-bot']}
    />,
    t,
  );

  const output = renderer.lastFrame() ?? '';
  // Ink writes <Static> items separately from the live frame; dynamic-only
  // rendering produces a single frame for this input.
  t.true(renderer.frames.length > 1);
  t.true(output.includes('restored answer'));
});

test.serial('MessageList updates static history when a message with the same id is corrected', async (t) => {
  const renderer = await renderInAct(
    <MessageList messages={[{ id: 'corrected-message', sender: 'bot', status: 'finalized', text: 'Hello wrold' }]} />,
    t,
  );

  await rerenderInAct(
    renderer,
    <MessageList messages={[{ id: 'corrected-message', sender: 'bot', status: 'finalized', text: 'Hello world' }]} />,
  );

  const output = renderer.lastFrame() ?? '';
  t.true(output.includes('Hello world'));
  t.false(output.includes('Hello wrold'));
});

test.serial('MessageList appends a fresh startup banner after clearing conversation history', async (t) => {
  const settingsService = createMockSettingsService();
  const renderer = await renderInAct(
    <MessageList
      messages={[{ id: 'one', sender: 'bot', text: 'one' }]}
      bannerItems={['startup-banner-0']}
      settingsService={settingsService}
    />,
    t,
  );

  await rerenderInAct(
    renderer,
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

test.serial('MessageList moves a message from active to static without duplicating it', async (t) => {
  const renderer = await renderInAct(
    <MessageList
      messages={[
        { id: 'before', sender: 'bot', text: 'before' },
        { id: 'running-command', sender: 'command', status: 'running', command: 'npm test', output: '' },
      ]}
    />,
    t,
  );

  await rerenderInAct(
    renderer,
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

test.serial(
  'MessageList preserves order when a live markdown message becomes a static prefix and live suffix',
  async (t) => {
    const renderer = await renderInAct(
      <MessageList
        messages={[
          {
            id: 'live-bot',
            sender: 'bot',
            status: 'streaming',
            text: 'Earlier paragraph.\n\n---\n\n### The boundary\n\nThe dividing line is still streaming',
          },
        ]}
      />,
      t,
    );

    await rerenderInAct(
      renderer,
      <MessageList
        messages={[
          {
            id: 'live-bot',
            sender: 'bot',
            status: 'finalized',
            text: 'Earlier paragraph.\n\n---\n\n### The boundary\n\n',
          },
          {
            id: 'live-tail',
            sender: 'bot',
            status: 'streaming',
            text: 'The dividing line is still streaming',
          },
        ]}
      />,
    );

    const output = stripAnsi(renderer.lastFrame() ?? '');
    const headingIndex = output.indexOf('### The boundary');
    const paragraphIndex = output.indexOf('The dividing line is still streaming');

    t.true(headingIndex >= 0);
    t.true(paragraphIndex > headingIndex);
    t.is(countOccurrences(output, '### The boundary'), 1);
    t.is(countOccurrences(output, 'The dividing line is still streaming'), 1);
  },
);

test.serial('MessageList moves a completed command before active reasoning directly into static history', async (t) => {
  const renderer = await renderInAct(
    <MessageList
      messages={[{ id: 'running-command', sender: 'command', status: 'running', command: 'npm test', output: '' }]}
    />,
    t,
  );

  await rerenderInAct(
    renderer,
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

test.serial('MessageList preserves spaces in bot text immediately before a command message', async (t) => {
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

  const { lastFrame } = await renderInAct(<MessageList messages={messages} />, t);
  const output = stripAnsi(lastFrame() ?? '');

  t.true(output.includes('read this file:'));
  t.false(output.includes('read thisfile:'));
});

test.serial('MessageList renders a compact subagent activity peek', async (t) => {
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

  const { lastFrame } = await renderInAct(<MessageList messages={messages} />, t);
  const output = stripAnsi(lastFrame() ?? '');

  t.true(output.includes('grep'));
  t.true(output.includes('read_file'));
  t.true(output.includes('read_code_outline'));
});

test.serial('MessageList renders active and static markdown tables with the same padded width', async (t) => {
  const markdown = `| File | Change |
| --- | --- |
| \`openai-compatible/model.ts\` | Track \`reasoningContent\` separately from \`reasoning\`; emit both \`reasoning_content\` and \`providerData\` in messages and function_calls; accumulate \`reasoning_content\` delta in streams |`;

  const renderer = await renderInAct(
    <MessageList messages={[{ id: 'table', sender: 'bot', status: 'streaming', text: markdown }]} />,
    t,
  );
  const activeBorder = firstTableBorder(renderer.lastFrame() ?? '');

  await rerenderInAct(
    renderer,
    <MessageList messages={[{ id: 'table', sender: 'bot', status: 'finalized', text: markdown }]} />,
  );
  const staticBorder = firstTableBorder(renderer.lastFrame() ?? '');

  t.regex(activeBorder, /^ {2,}\+/);
  t.is(staticBorder, activeBorder);
});

test.serial('MessageList renders active and static wrapped text with the same line breaks', async (t) => {
  const text =
    'This paragraph is intentionally long enough to wrap near the terminal boundary while the message is streaming and must keep the same wrapped shape after it is finalized.';

  const renderer = await renderInAct(
    <MessageList messages={[{ id: 'paragraph', sender: 'bot', status: 'streaming', text }]} />,
    t,
  );
  const activeLines = renderedLines(renderer.lastFrame() ?? '');

  await rerenderInAct(
    renderer,
    <MessageList messages={[{ id: 'paragraph', sender: 'bot', status: 'finalized', text }]} />,
  );
  const staticLines = renderedLines(renderer.lastFrame() ?? '');

  t.true(activeLines.length > 1);
  t.deepEqual(staticLines, activeLines);
});

test.serial('shouldCommitMessageToStatic commits restored finalized history immediately on first render', async (t) => {
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

test.serial('shouldCommitMessageToStatic keeps fresh finalized messages deferred on first render', async (t) => {
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

test.serial('shouldCommitMessageToStatic commits completed commands immediately on first render', async (t) => {
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

test.serial('MessageList commits a first-seen completed command directly to Static', async (t) => {
  const renderer = await renderInAct(
    <MessageList
      messages={[{ id: 'done-command', sender: 'command', status: 'completed', command: 'pwd', output: '/repo' }]}
    />,
    t,
  );

  t.true(renderer.frames.length > 1);
  t.true((renderer.lastFrame() ?? '').includes('/repo'));
});

test.serial('splitStaticHistory keeps running command messages active regardless of position', async (t) => {
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

test.serial('splitStaticHistory keeps completed commands behind an earlier running command active', async (t) => {
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

test.serial('splitStaticHistory keeps bot text before a running command active', async (t) => {
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

test.serial('splitStaticHistory keeps reasoning before a running command active', async (t) => {
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

test.serial('splitStaticHistory keeps unfinalized reasoning messages and following messages active', async (t) => {
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

test.serial('splitStaticHistory keeps streaming bot messages and following messages active', async (t) => {
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

test.serial('splitStaticHistory moves finalized bot messages to static history', async (t) => {
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

test.serial('splitStaticHistory preserves chronological order after the first active message', async (t) => {
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

test.serial('splitStaticHistory moves finalized reasoning messages to static history', async (t) => {
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

test.serial('MessageList continuation across static-dynamic boundary has correct spacing', async (t) => {
  const messages = [
    { id: 'chunk-1', sender: 'bot', status: 'finalized', text: '## Heading\n\n' },
    { id: 'chunk-2', sender: 'bot', status: 'streaming', text: 'Paragraph' },
  ];
  const { lastFrame } = await renderInAct(<MessageList messages={messages} />, t);
  const lines = renderedLines(lastFrame() ?? '');
  const headingIndex = lines.findIndex((line) => line.includes('## Heading'));
  const paragraphIndex = lines.findIndex((line) => line.includes('Paragraph'));
  t.true(headingIndex !== -1);
  t.true(paragraphIndex !== -1);
  // Exactly one blank line between heading and paragraph (markdown spacing only)
  t.is(paragraphIndex - headingIndex, 2);
});

test.serial('MessageList continuation within dynamic items has correct spacing', async (t) => {
  const messages = [
    { id: 'chunk-1', sender: 'bot', status: 'streaming', text: '## Heading\n\n' },
    { id: 'chunk-2', sender: 'bot', status: 'streaming', text: 'Paragraph' },
  ];
  const { lastFrame } = await renderInAct(<MessageList messages={messages} />, t);
  const lines = renderedLines(lastFrame() ?? '');
  const headingIndex = lines.findIndex((line) => line.includes('## Heading'));
  const paragraphIndex = lines.findIndex((line) => line.includes('Paragraph'));
  t.true(headingIndex !== -1);
  t.true(paragraphIndex !== -1);
  // Exactly one blank line between heading and paragraph (markdown spacing only)
  t.is(paragraphIndex - headingIndex, 2);
});

test.serial('MessageList non-continuation across static-dynamic boundary has correct spacing', async (t) => {
  const messages = [
    { id: 'user-msg', sender: 'user', text: 'hello', status: 'finalized' },
    { id: 'bot-msg', sender: 'bot', text: 'Paragraph', status: 'streaming' },
  ];
  const { lastFrame } = await renderInAct(<MessageList messages={messages} />, t);
  const lines = renderedLines(lastFrame() ?? '');
  const userIndex = lines.findIndex((line) => line.includes('❯ hello'));
  const botIndex = lines.findIndex((line) => line.includes('Paragraph'));
  t.true(userIndex !== -1);
  t.true(botIndex !== -1);
  // Exactly one blank line between user and bot (marginTop spacing only)
  t.is(botIndex - userIndex, 2);
});

test.serial('MessageList does not strand blank lines mid-history when reasoning streams in chunks', async (t) => {
  // Reproduces the chunked-reasoning trigger: a finalized chunk is briefly the
  // last item with no dynamic tail (a safe boundary landed at the end of the
  // buffer, so no live tail was pushed), then reasoning resumes and more
  // chunks are appended. The trailing spacer must not get frozen into the
  // write-once static buffer between the two chunks.
  const renderer = await renderInAct(
    <MessageList
      messages={[
        { id: 'chunk-a', sender: 'reasoning', status: 'finalized', text: 'alpha reasoning chunk' },
        { id: 'tail', sender: 'reasoning', status: 'streaming', text: 'live tail' },
      ]}
    />,
    t,
  );

  // Boundary at end of buffer: the tail is finalized in place, no new tail.
  await rerenderInAct(
    renderer,
    <MessageList
      messages={[
        { id: 'chunk-a', sender: 'reasoning', status: 'finalized', text: 'alpha reasoning chunk' },
        { id: 'tail', sender: 'reasoning', status: 'finalized', text: 'bravo reasoning chunk' },
      ]}
    />,
  );

  // Reasoning resumes and appends another chunk below the now-static history.
  await rerenderInAct(
    renderer,
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

test.serial('MessageList outputs a blank line after the final message in Static', async (t) => {
  const messages = [{ id: 'static-msg', sender: 'bot', status: 'finalized', text: 'final static message' }];
  const { lastFrame } = await renderInAct(<MessageList messages={messages} />, t);
  const output = lastFrame() ?? '';

  // Since the last message is finalized, it is output to Static.
  // It should end with a blank line because of the Box height={1} added inside renderStaticItem.
  const lines = output.split('\n');
  t.true(lines.length > 0);
  t.is(lines[lines.length - 1].trim(), '');
});

test.serial('MessageList hides reasoning messages when displayMode is concise', async (t) => {
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

  const { lastFrame } = await renderInAct(<MessageList messages={messages} settingsService={mockSettingsService} />, t);
  const output = lastFrame() ?? '';

  t.true(output.includes('Hello'), `Expected user message: ${output}`);
  t.true(output.includes('Hello back!'), `Expected bot message: ${output}`);
  t.false(output.includes('thinking'), `Expected reasoning message to be hidden: ${output}`);
});

test.serial(
  'MessageList retains chronological order when active message is finalized in the same tick as a new finalized message that was never active',
  async (t) => {
    const renderer = await renderInAct(
      <MessageList messages={[{ id: 'list-msg', sender: 'bot', status: 'streaming', text: '- list item' }]} />,
      t,
    );

    await rerenderInAct(
      renderer,
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
  },
);

// --- Bug fix: headings rendered after content (cross-render toolLeadIn duplication) ---

// When a message is committed to <Static> in one render and then becomes a
// toolLeadIn (moved from history into the active area) in a later render, it
// must NOT be rendered in both the static and dynamic areas simultaneously.
test.serial(
  'MessageList does not duplicate heading when it becomes toolLeadIn after being committed to static',
  async (t) => {
    // Render 1: Heading is streaming
    const renderer = await renderInAct(
      <MessageList messages={[{ id: 'heading', sender: 'bot', status: 'streaming', text: '### Intro' }]} />,
      t,
    );

    // Render 2: Heading finalizes (committed to static)
    await rerenderInAct(
      renderer,
      <MessageList messages={[{ id: 'heading', sender: 'bot', status: 'finalized', text: '### Intro' }]} />,
    );

    // Render 3: A command starts running (heading becomes toolLeadIn)
    // Without the fix, heading would appear in both static AND dynamic areas.
    await rerenderInAct(
      renderer,
      <MessageList
        messages={
          [
            { id: 'heading', sender: 'bot', status: 'finalized', text: '### Intro' },
            { id: 'cmd', sender: 'command', status: 'running', command: 'ls', output: '', toolName: 'shell' },
          ] as any
        }
      />,
    );

    const output = stripAnsi(renderer.lastFrame() ?? '');
    const introCount = (output.match(/### Intro/g) || []).length;
    t.is(introCount, 1, `Heading should appear exactly once, not duplicated. Output: \n${output}`);
  },
);

// When a heading was committed to static and a command later completes,
// the heading and command should appear in the correct order.
test.serial(
  'MessageList preserves heading-command order when heading was committed before command appeared',
  async (t) => {
    const renderer = await renderInAct(
      <MessageList messages={[{ id: 'heading', sender: 'bot', status: 'streaming', text: '### Setup' }]} />,
      t,
    );

    // Heading finalizes (committed to static)
    await rerenderInAct(
      renderer,
      <MessageList messages={[{ id: 'heading', sender: 'bot', status: 'finalized', text: '### Setup' }]} />,
    );

    // Command completes after heading
    await rerenderInAct(
      renderer,
      <MessageList
        messages={
          [
            { id: 'heading', sender: 'bot', status: 'finalized', text: '### Setup' },
            {
              id: 'cmd',
              sender: 'command',
              status: 'completed',
              command: 'npm install',
              output: 'added 10 packages',
              toolName: 'shell',
            },
          ] as any
        }
      />,
    );

    const output = stripAnsi(renderer.lastFrame() ?? '');
    const headingIdx = output.indexOf('### Setup');
    const cmdIdx = output.indexOf('npm install');

    t.true(headingIdx !== -1, 'Heading should be present');
    t.true(cmdIdx !== -1, 'Command should be present');
    t.true(headingIdx < cmdIdx, `Heading should render before command. Output: \n${output}`);
  },
);

// When content was already in static and a heading appears later as toolLeadIn,
// the heading must not be duplicated and the order must be preserved.
test.serial('MessageList preserves order when earlier content is static and heading becomes toolLeadIn', async (t) => {
  // Render 1: Content streaming then finalized
  const renderer = await renderInAct(
    <MessageList messages={[{ id: 'content', sender: 'bot', status: 'streaming', text: 'Body text' }]} />,
    t,
  );

  // Content finalizes (committed to static)
  await rerenderInAct(
    renderer,
    <MessageList messages={[{ id: 'content', sender: 'bot', status: 'finalized', text: 'Body text' }]} />,
  );

  // A new heading + command appears (heading is toolLeadIn for command)
  // BUT: content was committed before the heading appeared. The new messages
  // arrive after the already-committed content.
  await rerenderInAct(
    renderer,
    <MessageList
      messages={
        [
          { id: 'content', sender: 'bot', status: 'finalized', text: 'Body text' },
          { id: 'heading', sender: 'bot', status: 'finalized', text: '### Next Section' },
          { id: 'cmd', sender: 'command', status: 'running', command: 'ls', output: '', toolName: 'shell' },
        ] as any
      }
    />,
  );

  const output = stripAnsi(renderer.lastFrame() ?? '');
  const contentIdx = output.indexOf('Body text');
  const headingIdx = output.indexOf('### Next Section');

  t.true(contentIdx !== -1, 'Content should be present');
  t.true(headingIdx !== -1, 'Heading should be present');
  t.true(contentIdx < headingIdx, `Content should render before heading. Output: \n${output}`);
});
