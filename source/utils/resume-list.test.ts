import { it, expect } from 'vitest';
import { formatResumeList } from './resume-list.js';

// Strip ANSI escape codes to simplify string matching in assertions
function stripAnsi(str: string): string {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

it('formatResumeList: handles empty list', () => {
  const result = formatResumeList([]);
  expect(result).toBe('No saved conversations found.');
});

it('formatResumeList: formats a local conversation', () => {
  const entries = [
    {
      id: 'local-conv-id-123',
      updatedAt: '2026-05-28T14:40:16.000Z',
      projectPath: '/Users/qduc/src/term2',
    },
  ];

  const result = stripAnsi(formatResumeList(entries));
  expect(result.includes('Recent Conversations (last 10):')).toBe(true);
  expect(result.includes('1. local-conv-id-123')).toBe(true);
  expect(result.includes('Updated: 2026-05-28')).toBe(true); // Just check date format part
  expect(result.includes('local')).toBe(true);
  expect(result.includes('Project:')).toBe(false);
  expect(result.includes('Resume:  term2 --resume local-conv-id-123')).toBe(true);
});

it('formatResumeList: formats a remote/SSH conversation', () => {
  const entries = [
    {
      id: 'ssh-conv-id-456',
      updatedAt: '2026-05-28T14:30:00.000Z',
      projectPath: '/home/user/term2',
      sshHost: 'my-remote-server',
    },
  ];

  const result = stripAnsi(formatResumeList(entries));
  expect(result.includes('1. ssh-conv-id-456')).toBe(true);
  expect(result.includes('SSH: my-remote-server')).toBe(true);
  expect(result.includes('Project:')).toBe(false);
  expect(
    result.includes('Resume:  term2 --ssh my-remote-server --remote-dir /home/user/term2 --resume ssh-conv-id-456'),
  ).toBe(true);
});

it('formatResumeList: handles multiple conversations with correct index', () => {
  const entries = [
    {
      id: 'id-1',
      updatedAt: '2026-05-28T14:40:16.000Z',
    },
    {
      id: 'id-2',
      updatedAt: '2026-05-28T14:30:00.000Z',
      sshHost: 'another-host',
    },
  ];

  const result = stripAnsi(formatResumeList(entries));
  expect(result.includes('1. id-1')).toBe(true);
  expect(result.includes('2. id-2')).toBe(true);
  expect(result.includes('Resume:  term2 --resume id-1')).toBe(true);
  expect(result.includes('Resume:  term2 --ssh another-host --resume id-2')).toBe(true);
});

it('formatResumeList: formats a local conversation with prompt, model, and mode metadata', () => {
  const entries = [
    {
      id: 'local-conv-id-123',
      updatedAt: '2026-05-28T14:40:16.000Z',
      projectPath: '/Users/qduc/src/term2',
      firstUserMessage: 'hello dear agent',
      model: 'gemini-3.5-flash',
      messageCount: 5,
      appMode: {
        mentorMode: false,
        liteMode: true,
        planMode: false,
        orchestratorMode: false,
      },
    },
  ];

  const result = stripAnsi(formatResumeList(entries));
  expect(result.includes('Recent Conversations (last 10):')).toBe(true);
  expect(result.includes('1. local-conv-id-123')).toBe(true);
  expect(result.includes('Updated: 2026-05-28')).toBe(true);
  expect(result.includes('local')).toBe(true);
  expect(result.includes('5 messages')).toBe(true);
  expect(result.includes('model: gemini-3.5-flash')).toBe(true);
  expect(result.includes('mode: lite')).toBe(true);
  expect(result.includes('Project:')).toBe(false);
  expect(result.includes('Prompt:  "hello dear agent"')).toBe(true);
  expect(result.includes('Resume:  term2 --resume local-conv-id-123')).toBe(true);
});
