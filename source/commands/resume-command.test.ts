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

function createHarness() {
  const replaceInput = vi.fn();
  const resumeConversation = vi.fn();
  const messages: string[] = [];
  const command = createResumeSlashCommand({
    listConversations: () => mockConversations,
    resumeConversation,
    addSystemMessage: (message) => messages.push(message),
    replaceInput,
  });

  return { command, replaceInput, resumeConversation, messages };
}

it('createResumeSlashCommand returns correct command metadata', () => {
  const { command: cmd } = createHarness();

  expect(cmd.name).toBe('resume');
  expect(cmd.description).toBe('Resume a saved conversation (browse with /resume)');
  expect(cmd.expectsArgs).toBe(true);
  expect(cmd.completion).toEqual({
    type: 'resume',
    trigger: RESUME_TRIGGER,
  });
});

it('action with empty args or ls triggers replaceInput with RESUME_TRIGGER', () => {
  const { command: cmd, replaceInput, resumeConversation } = createHarness();

  expect(cmd.action('')).toBe(false);
  expect(replaceInput).toHaveBeenCalledWith(RESUME_TRIGGER);
  expect(resumeConversation).not.toHaveBeenCalled();

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
  const { command: cmd, replaceInput, resumeConversation } = createHarness();

  const result = cmd.action('conv-1');
  expect(result).toBe(true);
  await Promise.resolve();
  expect(resumeConversation).toHaveBeenCalledWith('conv-1');
  expect(replaceInput).not.toHaveBeenCalled();
});

it('action with invalid argument format returns error message', () => {
  const { command: cmd, resumeConversation, messages } = createHarness();

  expect(cmd.action('conv-1 extra')).toBe(true);
  expect(messages[0]).toBe('Usage: /resume [ls | conversation-id]');

  messages.length = 0;
  expect(cmd.action('../bad/path')).toBe(true);
  expect(messages[0]).toContain('Invalid conversation id');
  expect(resumeConversation).not.toHaveBeenCalled();
});
