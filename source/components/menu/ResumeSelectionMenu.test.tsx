// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import ResumeSelectionMenu from './ResumeSelectionMenu.js';
import type { ConversationListEntry } from '../../services/conversation/conversation-persistence.js';

const MOCK_CONVERSATIONS: ConversationListEntry[] = [
  {
    id: 'session-alpha-123',
    updatedAt: '2026-08-30T10:00:00.000Z',
    firstUserMessage: 'Initial prompt for alpha session',
    model: 'gpt-5.5',
    sshHost: 'remote-srv',
    messageCount: 10,
  },
  {
    id: 'session-beta-456',
    updatedAt: '2026-08-29T15:30:00.000Z',
    firstUserMessage: 'Initial prompt for beta session',
    model: 'claude-3-7-sonnet',
    messageCount: 5,
  },
];

it('ResumeSelectionMenu renders list and details of the selected conversation', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(<ResumeSelectionMenu items={MOCK_CONVERSATIONS} selectedIndex={0} query="" />);
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame).toBeTruthy();
  const frame = lastFrame();

  // Left column displays the conversation IDs
  expect(frame?.includes('session-alpha-123')).toBe(true);
  expect(frame?.includes('session-beta-456')).toBe(true);

  // Right column displays selected conversation details
  expect(frame?.includes('Initial prompt for alpha session')).toBe(true);
  expect(frame?.includes('SSH (remote-srv)')).toBe(true);
  expect(frame?.includes('10 msgs')).toBe(true);
  expect(frame?.includes('gpt-5.5')).toBe(true);

  // Unselected conversation prompt not shown
  expect(frame?.includes('Initial prompt for beta session')).toBe(false);

  await act(async () => {
    unmount();
  });
});

it('ResumeSelectionMenu displays fallback text when there are no conversations', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(<ResumeSelectionMenu items={[]} selectedIndex={0} query="" />);
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame).toBeTruthy();
  let frame = lastFrame();
  expect(frame?.includes('No saved conversations found')).toBe(true);

  await act(async () => {
    unmount();
  });

  // With query
  await act(async () => {
    const result = render(<ResumeSelectionMenu items={[]} selectedIndex={0} query="nonexistent" />);
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame).toBeTruthy();
  frame = lastFrame();
  expect(frame?.includes('No matching conversations')).toBe(true);

  await act(async () => {
    unmount();
  });
});

it('ResumeSelectionMenu prefers canonical profile identity over legacy mode flags', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(
      <ResumeSelectionMenu
        items={[
          {
            id: 'canonical-profile',
            updatedAt: '2026-08-30T10:00:00.000Z',
            activeProfileId: 'builtin:plan',
            appMode: { mentorMode: true, liteMode: false, planMode: false, orchestratorMode: false },
          },
        ]}
        selectedIndex={0}
        query=""
      />,
    );
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame()).toContain('mode: plan');
  expect(lastFrame()).not.toContain('mode: mentor');

  await act(async () => {
    unmount();
  });
});

const WRAPPING_CONVERSATIONS: ConversationListEntry[] = [
  {
    id: 'session-alpha-123-with-a-very-long-suffix-to-force-overflow-conditions',
    updatedAt: '2026-08-30T10:00:00.000Z',
    // Short enough to survive the intentional 150-char excerpt truncation
    // even on a 24-col terminal; the long id above is the overflow stress.
    firstUserMessage: 'Alpha opener',
    model: 'gpt-5.5',
    messageCount: 10,
  },
  {
    id: 'session-beta-456',
    updatedAt: '2026-08-29T15:30:00.000Z',
    firstUserMessage: 'beta prompt',
    messageCount: 5,
  },
];

// Same split-pane contract as the skills menu: stable gutter, straight
// divider, full detail, nothing past the terminal edge.
for (const width of [80, 40, 24]) {
  it.sequential(`keeps the list gutter, divider, and full detail at ${width} cols`, async () => {
    const { lastFrame } = await renderInAct(
      <Box width={width}>
        <ResumeSelectionMenu items={WRAPPING_CONVERSATIONS} selectedIndex={0} query="" />
      </Box>,
    );

    const frame = toVisibleText(lastFrame()!);
    const lines = frame.split('\n');

    expect(lines.some((line) => /❯ /.test(line))).toBe(true);
    // The list column is half the row at every width, so a long id shows as a
    // stub on narrow terminals; only its prefix is guaranteed.
    const betaLine = lines.find((line) => line.includes('sess') && !line.includes('❯'));
    expect(betaLine).toBeDefined();

    const dividerColumns = lines
      .filter((line) => line.trim().length > 0)
      .filter((line) => !/navigate|select|resume|cancel|switch/.test(line))
      .map((line) => {
        const indices: number[] = [];
        for (let i = 1; i < line.length - 1; i++) {
          if (line[i] === '│') indices.push(i);
        }
        return indices;
      })
      .filter((indices) => indices.length > 0)
      .map((indices) => indices[0]);
    expect(dividerColumns.length).toBeGreaterThan(0);
    expect(new Set(dividerColumns).size).toBe(1);

    // The full id survives in the detail pane even where the list shows a
    // stub. The detail text is read down its own column: row-major order
    // would interleave list rows between the detail's wrapped lines on wide
    // terminals.
    const divider = dividerColumns[0];
    const detailCompact = lines
      .map((line) => (line[divider] === '│' ? line.slice(divider + 1) : line))
      .join('\n')
      .replace(/[│╭╮╰╯─]/g, '')
      .replace(/\s+/g, '');
    const words = (s: string) => s.replace(/\s+/g, '');
    expect(detailCompact).toContain('session-alpha-123-with-a-very-long-suffix-to-force-overflow-conditions');
    // The excerpt line is single-line truncate, so on a half-row detail pane
    // only its opening survives.
    expect(detailCompact).toContain(width >= 40 ? words('Alpha opener') : 'Alpha');
    expect(detailCompact).toContain(words('10 msgs'));
    expect(detailCompact).toContain('gpt-5.5');

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });
}
