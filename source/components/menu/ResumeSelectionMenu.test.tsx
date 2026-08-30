// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
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
