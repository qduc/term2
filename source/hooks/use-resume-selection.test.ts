import { it, expect } from 'vitest';
import { filterConversations } from './use-resume-selection.js';
import type { ConversationListEntry } from '../services/conversation/conversation-persistence.js';

const MOCK_CONVERSATIONS: ConversationListEntry[] = [
  {
    id: 'conv-2026-08-30-alpha',
    updatedAt: '2026-08-30T10:00:00.000Z',
    firstUserMessage: 'Refactor database models',
    model: 'gpt-5.5',
    sshHost: 'prod-server',
    messageCount: 8,
  },
  {
    id: 'conv-2026-08-29-beta',
    updatedAt: '2026-08-29T14:30:00.000Z',
    firstUserMessage: 'Fix styling in UI components',
    model: 'claude-3-7-sonnet',
    messageCount: 4,
  },
  {
    id: 'conv-2026-08-28-gamma',
    updatedAt: '2026-08-28T09:15:00.000Z',
    firstUserMessage: 'Add unit tests for auth',
    model: 'gpt-5.5',
    sshHost: 'staging-box',
    messageCount: 15,
  },
];

it('filterConversations - empty query returns all conversations', () => {
  const result = filterConversations(MOCK_CONVERSATIONS, '');
  expect(result.length).toBe(3);
  expect(result).toEqual(MOCK_CONVERSATIONS);
});

it('filterConversations - matches by id (case insensitive)', () => {
  const result = filterConversations(MOCK_CONVERSATIONS, 'ALPHA');
  expect(result.length).toBe(1);
  expect(result[0]!.id).toBe('conv-2026-08-30-alpha');
});

it('filterConversations - matches by first user message content', () => {
  const result = filterConversations(MOCK_CONVERSATIONS, 'styling in UI');
  expect(result.length).toBe(1);
  expect(result[0]!.id).toBe('conv-2026-08-29-beta');
});

it('filterConversations - matches by model name', () => {
  const result = filterConversations(MOCK_CONVERSATIONS, 'claude');
  expect(result.length).toBe(1);
  expect(result[0]!.id).toBe('conv-2026-08-29-beta');

  const gptResult = filterConversations(MOCK_CONVERSATIONS, 'gpt-5.5');
  expect(gptResult.length).toBe(2);
});

it('filterConversations - matches by ssh host', () => {
  const result = filterConversations(MOCK_CONVERSATIONS, 'staging-box');
  expect(result.length).toBe(1);
  expect(result[0]!.id).toBe('conv-2026-08-28-gamma');
});

it('filterConversations - no match returns empty array', () => {
  const result = filterConversations(MOCK_CONVERSATIONS, 'nonexistent');
  expect(result.length).toBe(0);
});
