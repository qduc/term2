import { it, expect, vi } from 'vitest';
import { createResumeSlashCommand } from './resume-command.js';
import type { ConversationListEntry } from '../services/conversation/conversation-persistence.js';
import { RESUME_TRIGGER } from '../components/input/triggers.js';

const mockConversations: ConversationListEntry[] = [
  {
    id: 'conv-1',
    updatedAt: '2026-08-30T10:00:00.000Z',
    firstUserMessage: 'Fix bugs in codebase',
    model: 'gpt-5.5',
    messageCount: 5,
  },
  {
    id: 'conv-2',
    updatedAt: '2026-08-29T15:30:00.000Z',
    firstUserMessage: 'Refactor tests',
    model: 'claude-3-7-sonnet',
    messageCount: 12,
  },
];

it('createResumeSlashCommand returns correct command metadata', () => {
  const cmd = createResumeSlashCommand({
    listConversations: () => mockConversations,
    resumeConversation: vi.fn(),
    addSystemMessage: vi.fn(),
    replaceInput: vi.fn(),
  });

  expect(cmd.name).toBe('resume');
  expect(cmd.description).toBe('Resume a saved conversation (browse with /resume)');
  expect(cmd.expectsArgs).toBe(true);
  expect(cmd.completion).toEqual({
    type: 'resume',
    trigger: RESUME_TRIGGER,
  });
});

it('action with empty args or ls triggers replaceInput with RESUME_TRIGGER', () => {
  const replaceInput = vi.fn();
  const resumeMock = vi.fn();
  const msgMock = vi.fn();

  const cmd = createResumeSlashCommand({
    listConversations: () => mockConversations,
    resumeConversation: resumeMock,
    addSystemMessage: msgMock,
    replaceInput,
  });

  expect(cmd.action('')).toBe(false);
  expect(replaceInput).toHaveBeenCalledWith(RESUME_TRIGGER);
  expect(resumeMock).not.toHaveBeenCalled();

  replaceInput.mockClear();
  expect(cmd.action(undefined)).toBe(false);
  expect(replaceInput).toHaveBeenCalledWith(RESUME_TRIGGER);

  replaceInput.mockClear();
  expect(cmd.action('ls')).toBe(false);
  expect(replaceInput).toHaveBeenCalledWith(RESUME_TRIGGER);

  replaceInput.mockClear();
  expect(cmd.action('list')).toBe(false);
  expect(replaceInput).toHaveBeenCalledWith(RESUME_TRIGGER);
});

it('action with specific conversation id calls resumeConversation', async () => {
  const replaceInput = vi.fn();
  const resumeMock = vi.fn(async () => {});
  const msgMock = vi.fn();

  const cmd = createResumeSlashCommand({
    listConversations: () => mockConversations,
    resumeConversation: resumeMock,
    addSystemMessage: msgMock,
    replaceInput,
  });

  const result = cmd.action('conv-1');
  expect(result).toBe(true);
  expect(resumeMock).toHaveBeenCalledWith('conv-1');
  expect(replaceInput).not.toHaveBeenCalled();
});

it('action with invalid argument format returns error message', () => {
  const replaceInput = vi.fn();
  const resumeMock = vi.fn();
  const messages: string[] = [];

  const cmd = createResumeSlashCommand({
    listConversations: () => mockConversations,
    resumeConversation: resumeMock,
    addSystemMessage: (msg) => messages.push(msg),
    replaceInput,
  });

  expect(cmd.action('conv-1 extra')).toBe(true);
  expect(messages[0]).toBe('Usage: /resume [ls | conversation-id]');

  messages.length = 0;
  expect(cmd.action('../bad/path')).toBe(true);
  expect(messages[0]).toContain('Invalid conversation id');
  expect(resumeMock).not.toHaveBeenCalled();
});
