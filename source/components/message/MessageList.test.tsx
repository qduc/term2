// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import { renderInAct, rerenderInAct } from '../../test-helpers/ink-testing.js';
import MessageList, {
  detectStaticCommitBlocker,
  splitStaticHistory,
  shouldCommitMessageToStatic,
} from './MessageList.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';

const countOccurrences = (text: string, pattern: string) => text.split(pattern).length - 1;
const stripAnsi = (text: string) => text.replaceAll(/\u001B\[[0-9;]*m/g, '');
const firstTableBorder = (text: string) =>
  stripAnsi(text)
    .split('\n')
    .find((line) => line.trimStart().startsWith('+')) ?? '';
const renderedLines = (text: string) => stripAnsi(text).trim().split('\n');

it.sequential('MessageList renders user and bot messages', async () => {
  const messages = [
    { id: 1, sender: 'user', text: 'hello' },
    { id: 2, sender: 'bot', text: 'hi there' },
  ];
  const { lastFrame } = await renderInAct(<MessageList messages={messages} />);
  const output = lastFrame() ?? '';
  expect(output.includes('❯ hello')).toBe(true);
  expect(output.includes('hi there')).toBe(true);
});

it.sequential('MessageList renders image attachment summaries without leaked sentinel ids', async () => {
  const messages = [
    {
      id: 1,
      sender: 'user',
      text: 'Tell me what you see\n[1 image attached]',
    },
  ];

  const { lastFrame } = await renderInAct(<MessageList messages={messages} />);
  const output = lastFrame() ?? '';

  expect(output.includes('❯ Tell me what you see')).toBe(true);
  expect(output.includes('[1 image attached]')).toBe(true);
  expect(output.includes('f9uatvt88vql1')).toBe(false);
});

it.sequential('MessageList retains static history across rerenders', async () => {
  const renderer = await renderInAct(<MessageList messages={[{ id: 'one', sender: 'bot', text: 'one' }]} />);
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
  expect(output.includes('one')).toBe(true);
  expect(output.includes('two')).toBe(true);
});

it.sequential('MessageList commits restored finalized messages to Static on initial render', async () => {
  const renderer = await renderInAct(
    <MessageList
      messages={[{ id: 'restored-bot', sender: 'bot', status: 'finalized', text: 'restored answer' }]}
      restoredStaticMessageIds={['restored-bot']}
    />,
  );

  const output = renderer.lastFrame() ?? '';
  // Ink writes <Static> items separately from the live frame; dynamic-only
  // rendering produces a single frame for this input.
  expect(renderer.frames.length > 1).toBe(true);
  expect(output.includes('restored answer')).toBe(true);
});

it.sequential('MessageList updates static history when a message with the same id is corrected', async () => {
  const renderer = await renderInAct(
    <MessageList messages={[{ id: 'corrected-message', sender: 'bot', status: 'finalized', text: 'Hello wrold' }]} />,
  );

  await rerenderInAct(
    renderer,
    <MessageList messages={[{ id: 'corrected-message', sender: 'bot', status: 'finalized', text: 'Hello world' }]} />,
  );

  const output = renderer.lastFrame() ?? '';
  expect(output.includes('Hello world')).toBe(true);
  expect(output.includes('Hello wrold')).toBe(false);
});

it.sequential('MessageList appends a fresh startup banner after clearing conversation history', async () => {
  const settingsService = createMockSettingsService();
  const renderer = await renderInAct(
    <MessageList
      messages={[{ id: 'one', sender: 'bot', text: 'one' }]}
      bannerItems={['startup-banner-0']}
      settingsService={settingsService}
    />,
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
  expect(countOccurrences(output, 'term²')).toBe(2);
  expect(output.includes('one')).toBe(false);
});

it.sequential('MessageList moves a message from active to static without duplicating it', async () => {
  const renderer = await renderInAct(
    <MessageList
      messages={[
        { id: 'before', sender: 'bot', text: 'before' },
        { id: 'running-command', sender: 'command', status: 'running', command: 'npm test', output: '' },
      ]}
    />,
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
  expect(countOccurrences(output, 'before')).toBe(1);
  expect(countOccurrences(output, 'npm test')).toBe(1);
});

it.sequential(
  'MessageList preserves order when a live markdown message becomes a static prefix and live suffix',
  async () => {
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

    expect(headingIndex >= 0).toBe(true);
    expect(paragraphIndex > headingIndex).toBe(true);
    expect(countOccurrences(output, '### The boundary')).toBe(1);
    expect(countOccurrences(output, 'The dividing line is still streaming')).toBe(1);
  },
);

it.sequential(
  'MessageList moves a completed command before active reasoning directly into static history',
  async () => {
    const renderer = await renderInAct(
      <MessageList
        messages={[{ id: 'running-command', sender: 'command', status: 'running', command: 'npm test', output: '' }]}
      />,
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
    expect(countOccurrences(output, 'npm test')).toBe(1);
    expect(countOccurrences(output, 'thinking')).toBe(1);
  },
);

it.sequential('MessageList preserves spaces in bot text immediately before a command message', async () => {
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

  const { lastFrame } = await renderInAct(<MessageList messages={messages} />);
  const output = stripAnsi(lastFrame() ?? '');

  expect(output.includes('read this file:')).toBe(true);
  expect(output.includes('read thisfile:')).toBe(false);
});

it.sequential('MessageList renders a compact subagent activity peek', async () => {
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

  const { lastFrame } = await renderInAct(<MessageList messages={messages} />);
  const output = stripAnsi(lastFrame() ?? '');

  expect(output.includes('grep')).toBe(true);
  expect(output.includes('read_file')).toBe(true);
  expect(output.includes('read_code_outline')).toBe(true);
});

it.sequential('MessageList renders active and static markdown tables with the same padded width', async () => {
  const markdown = `| File | Change |
| --- | --- |
| \`openai-compatible/model.ts\` | Track \`reasoningContent\` separately from \`reasoning\`; emit both \`reasoning_content\` and \`providerData\` in messages and function_calls; accumulate \`reasoning_content\` delta in streams |`;

  const renderer = await renderInAct(
    <MessageList messages={[{ id: 'table', sender: 'bot', status: 'streaming', text: markdown }]} />,
  );
  const activeBorder = firstTableBorder(renderer.lastFrame() ?? '');

  await rerenderInAct(
    renderer,
    <MessageList messages={[{ id: 'table', sender: 'bot', status: 'finalized', text: markdown }]} />,
  );
  const staticBorder = firstTableBorder(renderer.lastFrame() ?? '');

  expect(activeBorder).toMatch(/^ {2,}\+/);
  expect(staticBorder).toBe(activeBorder);
});

it.sequential('MessageList renders active and static wrapped text with the same line breaks', async () => {
  const text =
    'This paragraph is intentionally long enough to wrap near the terminal boundary while the message is streaming and must keep the same wrapped shape after it is finalized.';

  const renderer = await renderInAct(
    <MessageList messages={[{ id: 'paragraph', sender: 'bot', status: 'streaming', text }]} />,
  );
  const activeLines = renderedLines(renderer.lastFrame() ?? '');

  await rerenderInAct(
    renderer,
    <MessageList messages={[{ id: 'paragraph', sender: 'bot', status: 'finalized', text }]} />,
  );
  const staticLines = renderedLines(renderer.lastFrame() ?? '');

  expect(activeLines.length > 1).toBe(true);
  expect(staticLines).toEqual(activeLines);
});

it.sequential('MessageList constrains active and static code blocks to the terminal width', async () => {
  const maxVisibleWidth = 100;
  const markdown = `\`\`\`ts
const value = "${'abcdefghijklmnopqrstuvwxyz'.repeat(5)}";
\`\`\``;

  const renderer = await renderInAct(
    <MessageList messages={[{ id: 'code', sender: 'bot', status: 'streaming', text: markdown }]} />,
  );
  const activeLines = renderedLines(renderer.lastFrame() ?? '');

  await rerenderInAct(
    renderer,
    <MessageList messages={[{ id: 'code', sender: 'bot', status: 'finalized', text: markdown }]} />,
  );
  const staticLines = renderedLines(renderer.lastFrame() ?? '');

  expect(
    activeLines.every((line) => line.length <= maxVisibleWidth),
    activeLines.join('\n'),
  ).toBe(true);
  expect(
    staticLines.every((line) => line.length <= maxVisibleWidth),
    staticLines.join('\n'),
  ).toBe(true);
  expect(staticLines).toEqual(activeLines);
});

it.sequential(
  'shouldCommitMessageToStatic commits restored finalized history immediately on first render',
  async () => {
    expect(
      shouldCommitMessageToStatic({
        hasActiveMessages: false,
        hasExistingStaticHistory: false,
        wasPreviouslyActive: false,
        hasPendingCandidateSignature: false,
        isRestoredMessage: true,
      }),
    ).toBe(true);
  },
);

it.sequential('shouldCommitMessageToStatic keeps fresh finalized messages deferred on first render', async () => {
  expect(
    shouldCommitMessageToStatic({
      hasActiveMessages: false,
      hasExistingStaticHistory: false,
      wasPreviouslyActive: false,
      hasPendingCandidateSignature: false,
      isRestoredMessage: false,
    }),
  ).toBe(false);
});

it.sequential('shouldCommitMessageToStatic commits completed commands immediately on first render', async () => {
  expect(
    shouldCommitMessageToStatic({
      hasActiveMessages: false,
      hasExistingStaticHistory: false,
      wasPreviouslyActive: false,
      hasPendingCandidateSignature: false,
      isRestoredMessage: false,
      isCompletedCommand: true,
    }),
  ).toBe(true);
});

it.sequential('MessageList commits a first-seen completed command directly to Static', async () => {
  const renderer = await renderInAct(
    <MessageList
      messages={[{ id: 'done-command', sender: 'command', status: 'completed', command: 'pwd', output: '/repo' }]}
    />,
  );

  expect(renderer.frames.length > 1).toBe(true);
  expect((renderer.lastFrame() ?? '').includes('/repo')).toBe(true);
});

it.sequential('splitStaticHistory keeps running command messages active regardless of position', async () => {
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

  expect(history.some((message) => message.id === 'running-command')).toBe(false);
  expect(active.some((message) => message.id === 'running-command')).toBe(true);
  // Only the prefix before the running command can be static without reordering output.
  expect(history.some((message) => message.id === 'msg-0')).toBe(true);
  expect(active.some((message) => message.id === 'tail-24')).toBe(true);
});

it.sequential('splitStaticHistory keeps completed commands behind an earlier running command active', async () => {
  const messages = [
    { id: 'older', sender: 'bot', text: 'older', status: 'finalized' },
    { id: 'running-command', sender: 'command', status: 'running', command: 'npm test', output: '' },
    { id: 'completed-command', sender: 'command', status: 'completed', command: 'pwd', output: '/repo' },
  ];

  const { history, active } = splitStaticHistory(messages);

  expect(active.some((message) => message.id === 'running-command')).toBe(true);
  expect(active.some((message) => message.id === 'completed-command')).toBe(true);
  expect(history.some((message) => message.id === 'completed-command')).toBe(false);
});

it.sequential('splitStaticHistory keeps bot text before a running command active', async () => {
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

  expect(history.map((message) => message.id)).toEqual(['older']);
  expect(active.map((message) => message.id)).toEqual(['before-tool', 'running-command']);
});

it.sequential('splitStaticHistory keeps reasoning before a running command active', async () => {
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

  expect(history.map((message) => message.id)).toEqual(['older']);
  expect(active.map((message) => message.id)).toEqual(['before-tool', 'running-command']);
});

it.sequential('splitStaticHistory keeps unfinalized reasoning messages and following messages active', async () => {
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

  expect(history.some((message) => message.id === 'msg-0')).toBe(true);
  expect(active.some((message) => message.id === 'tail-24')).toBe(true);
  expect(history.some((message) => message.id === 'reasoning-message')).toBe(false);
  expect(active.some((message) => message.id === 'reasoning-message')).toBe(true);
});

it.sequential('splitStaticHistory keeps streaming bot messages and following messages active', async () => {
  const messages = [
    { id: 'before', sender: 'bot', text: 'before', status: 'finalized' },
    { id: 'streaming-bot', sender: 'bot', text: 'partial', status: 'streaming' },
    { id: 'after', sender: 'bot', text: 'after', status: 'finalized' },
  ];

  const { history, active } = splitStaticHistory(messages);

  expect(history.map((message) => message.id)).toEqual(['before']);
  expect(active.map((message) => message.id)).toEqual(['streaming-bot', 'after']);
});

it.sequential('splitStaticHistory moves finalized bot messages to static history', async () => {
  const messages = [
    { id: 'first', sender: 'bot', text: 'first', status: 'finalized' },
    { id: 'second', sender: 'bot', text: 'second', status: 'finalized' },
  ];

  const { history, active } = splitStaticHistory(messages);

  expect(history.map((message) => message.id)).toEqual(['first', 'second']);
  expect(active).toEqual([]);
});

it.sequential('detectStaticCommitBlocker reports the first active message when the dynamic suffix is too long', () => {
  const blocker = detectStaticCommitBlocker(
    [
      { id: 'stable', sender: 'bot', text: 'stable', status: 'finalized' },
      { id: 'cmd', sender: 'command', status: 'running', command: 'npm test', output: '' },
      { id: 'after', sender: 'bot', text: 'after', status: 'finalized' },
    ],
    { messageCountThreshold: 2, textLengthThreshold: 1000 },
  );

  expect(blocker).toEqual({
    id: 'cmd',
    index: 1,
    sender: 'command',
    status: 'running',
    reason: 'command_running',
    dynamicMessageCount: 2,
    dynamicTextLength: 5,
  });
});

it.sequential('detectStaticCommitBlocker stays silent while the dynamic suffix is below thresholds', () => {
  const blocker = detectStaticCommitBlocker([{ id: 'bot', sender: 'bot', status: 'streaming', text: 'short tail' }], {
    messageCountThreshold: 2,
    textLengthThreshold: 1000,
  });

  expect(blocker).toBeNull();
});

it.sequential('detectStaticCommitBlocker can trigger on a large streaming text tail', () => {
  const blocker = detectStaticCommitBlocker(
    [{ id: 'bot', sender: 'bot', status: 'streaming', text: 'x'.repeat(1200) }],
    { messageCountThreshold: 20, textLengthThreshold: 1000 },
  );

  expect(blocker?.reason).toBe('bot_streaming');
  expect(blocker?.dynamicTextLength).toBe(1200);
});

it.sequential('splitStaticHistory preserves chronological order after the first active message', async () => {
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

  expect(history.map((message) => message.id)).toEqual(['before']);
  expect(active.map((message) => message.id)).toEqual(['running-command', 'completed-command', 'after']);
});

it.sequential('splitStaticHistory moves finalized reasoning messages to static history', async () => {
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

  expect(history.some((message) => message.id === 'finalized-reasoning')).toBe(true);
  expect(active.some((message) => message.id === 'finalized-reasoning')).toBe(false);
  expect(active.length).toBe(0);
});

it.sequential('MessageList continuation across static-dynamic boundary has correct spacing', async () => {
  const messages = [
    { id: 'chunk-1', sender: 'bot', status: 'finalized', text: '## Heading\n\n' },
    { id: 'chunk-2', sender: 'bot', status: 'streaming', text: 'Paragraph' },
  ];
  const { lastFrame } = await renderInAct(<MessageList messages={messages} />);
  const lines = renderedLines(lastFrame() ?? '');
  const headingIndex = lines.findIndex((line) => line.includes('## Heading'));
  const paragraphIndex = lines.findIndex((line) => line.includes('Paragraph'));
  expect(headingIndex !== -1).toBe(true);
  expect(paragraphIndex !== -1).toBe(true);
  // Exactly one blank line between heading and paragraph (markdown spacing only)
  expect(paragraphIndex - headingIndex).toBe(2);
});

it.sequential('MessageList continuation within dynamic items has correct spacing', async () => {
  const messages = [
    { id: 'chunk-1', sender: 'bot', status: 'streaming', text: '## Heading\n\n' },
    { id: 'chunk-2', sender: 'bot', status: 'streaming', text: 'Paragraph' },
  ];
  const { lastFrame } = await renderInAct(<MessageList messages={messages} />);
  const lines = renderedLines(lastFrame() ?? '');
  const headingIndex = lines.findIndex((line) => line.includes('## Heading'));
  const paragraphIndex = lines.findIndex((line) => line.includes('Paragraph'));
  expect(headingIndex !== -1).toBe(true);
  expect(paragraphIndex !== -1).toBe(true);
  // Exactly one blank line between heading and paragraph (markdown spacing only)
  expect(paragraphIndex - headingIndex).toBe(2);
});

it.sequential('MessageList non-continuation across static-dynamic boundary has correct spacing', async () => {
  const messages = [
    { id: 'user-msg', sender: 'user', text: 'hello', status: 'finalized' },
    { id: 'bot-msg', sender: 'bot', text: 'Paragraph', status: 'streaming' },
  ];
  const { lastFrame } = await renderInAct(<MessageList messages={messages} />);
  const lines = renderedLines(lastFrame() ?? '');
  const userIndex = lines.findIndex((line) => line.includes('❯ hello'));
  const botIndex = lines.findIndex((line) => line.includes('Paragraph'));
  expect(userIndex !== -1).toBe(true);
  expect(botIndex !== -1).toBe(true);
  // Exactly one blank line between user and bot (marginTop spacing only)
  expect(botIndex - userIndex).toBe(2);
});

it.sequential('MessageList does not strand blank lines mid-history when reasoning streams in chunks', async () => {
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

  expect(bravoIndex !== -1).toBe(true);
  expect(charlieIndex !== -1).toBe(true);
  // Exactly one blank line (non-continuation marginTop) between the two
  // reasoning chunks. The pre-fix bug baked an extra spacer Box below the
  // transiently-last 'bravo' chunk, producing a gap of 3.
  expect(charlieIndex - bravoIndex).toBe(2);
});

it.sequential('MessageList outputs a blank line after the final message in Static', async () => {
  const messages = [{ id: 'static-msg', sender: 'bot', status: 'finalized', text: 'final static message' }];
  const { lastFrame } = await renderInAct(<MessageList messages={messages} />);
  const output = lastFrame() ?? '';

  // Since the last message is finalized, it is output to Static.
  // It should end with a blank line because of the Box height={1} added inside renderStaticItem.
  const lines = output.split('\n');
  expect(lines.length > 0).toBe(true);
  expect(lines[lines.length - 1].trim()).toBe('');
});

it.sequential('MessageList hides reasoning messages when displayMode is concise', async () => {
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

  const { lastFrame } = await renderInAct(<MessageList messages={messages} settingsService={mockSettingsService} />);
  const output = lastFrame() ?? '';

  expect(output.includes('Hello')).toBe(true);
  expect(output.includes('Hello back!')).toBe(true);
  expect(output.includes('thinking')).toBe(false);
});

it.sequential(
  'MessageList retains chronological order when active message is finalized in the same tick as a new finalized message that was never active',
  async () => {
    const renderer = await renderInAct(
      <MessageList messages={[{ id: 'list-msg', sender: 'bot', status: 'streaming', text: '- list item' }]} />,
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

    expect(headingIndex !== -1).toBe(true);
    expect(listIndex !== -1).toBe(true);
    expect(headingIndex < listIndex).toBe(true);
  },
);

// --- Bug fix: headings rendered after content (cross-render toolLeadIn duplication) ---

// When a message is committed to <Static> in one render and then becomes a
// toolLeadIn (moved from history into the active area) in a later render, it
// must NOT be rendered in both the static and dynamic areas simultaneously.
it.sequential(
  'MessageList does not duplicate heading when it becomes toolLeadIn after being committed to static',
  async () => {
    // Render 1: Heading is streaming
    const renderer = await renderInAct(
      <MessageList messages={[{ id: 'heading', sender: 'bot', status: 'streaming', text: '### Intro' }]} />,
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
    expect(introCount, `Heading should appear exactly once, not duplicated. Output: \n${output}`).toBe(1);
  },
);

// When a heading was committed to static and a command later completes,
// the heading and command should appear in the correct order.
it.sequential(
  'MessageList preserves heading-command order when heading was committed before command appeared',
  async () => {
    const renderer = await renderInAct(
      <MessageList messages={[{ id: 'heading', sender: 'bot', status: 'streaming', text: '### Setup' }]} />,
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

    expect(headingIdx !== -1).toBe(true);
    expect(cmdIdx !== -1).toBe(true);
    expect(headingIdx < cmdIdx).toBe(true);
  },
);

// When content was already in static and a heading appears later as toolLeadIn,
// the heading must not be duplicated and the order must be preserved.
it.sequential('MessageList preserves order when earlier content is static and heading becomes toolLeadIn', async () => {
  // Render 1: Content streaming then finalized
  const renderer = await renderInAct(
    <MessageList messages={[{ id: 'content', sender: 'bot', status: 'streaming', text: 'Body text' }]} />,
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

  expect(contentIdx !== -1).toBe(true);
  expect(headingIdx !== -1).toBe(true);
  expect(contentIdx < headingIdx).toBe(true);
});
