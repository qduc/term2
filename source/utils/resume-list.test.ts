import test from 'ava';
import { formatResumeList } from './resume-list.js';

// Strip ANSI escape codes to simplify string matching in assertions
function stripAnsi(str: string): string {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

test('formatResumeList: handles empty list', (t) => {
  const result = formatResumeList([]);
  t.is(result, 'No saved conversations found.');
});

test('formatResumeList: formats a local conversation', (t) => {
  const entries = [
    {
      id: 'local-conv-id-123',
      updatedAt: '2026-05-28T14:40:16.000Z',
      projectPath: '/Users/qduc/src/term2',
    },
  ];

  const result = stripAnsi(formatResumeList(entries));
  t.true(result.includes('Recent Conversations (last 10):'));
  t.true(result.includes('1. local-conv-id-123'));
  t.true(result.includes('Updated: 2026-05-28')); // Just check date format part
  t.true(result.includes('local'));
  t.false(result.includes('Project:'));
  t.true(result.includes('Resume:  term2 --resume local-conv-id-123'));
});

test('formatResumeList: formats a remote/SSH conversation', (t) => {
  const entries = [
    {
      id: 'ssh-conv-id-456',
      updatedAt: '2026-05-28T14:30:00.000Z',
      projectPath: '/home/user/term2',
      sshHost: 'my-remote-server',
    },
  ];

  const result = stripAnsi(formatResumeList(entries));
  t.true(result.includes('1. ssh-conv-id-456'));
  t.true(result.includes('SSH: my-remote-server'));
  t.false(result.includes('Project:'));
  t.true(
    result.includes('Resume:  term2 --ssh my-remote-server --remote-dir /home/user/term2 --resume ssh-conv-id-456'),
  );
});

test('formatResumeList: handles multiple conversations with correct index', (t) => {
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
  t.true(result.includes('1. id-1'));
  t.true(result.includes('2. id-2'));
  t.true(result.includes('Resume:  term2 --resume id-1'));
  t.true(result.includes('Resume:  term2 --ssh another-host --resume id-2'));
});

test('formatResumeList: formats a local conversation with prompt, model, and mode metadata', (t) => {
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
  t.true(result.includes('Recent Conversations (last 10):'));
  t.true(result.includes('1. local-conv-id-123'));
  t.true(result.includes('Updated: 2026-05-28'));
  t.true(result.includes('local'));
  t.true(result.includes('5 messages'));
  t.true(result.includes('model: gemini-3.5-flash'));
  t.true(result.includes('mode: lite'));
  t.false(result.includes('Project:'));
  t.true(result.includes('Prompt:  "hello dear agent"'));
  t.true(result.includes('Resume:  term2 --resume local-conv-id-123'));
});
