import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { filterPendingCommandMessagesForApproval } from '../services/approval/approval-presentation-policy.js';

it('filters pending/running command messages matching approval callId', () => {
  const messages = [
    { id: 1, sender: 'user', text: 'hi' },
    {
      id: 'call-1',
      sender: 'command',
      status: 'running',
      command: 'echo hi',
      output: '',
      callId: 'call-1',
      toolName: 'shell',
    },
    {
      id: 'call-1-0',
      sender: 'command',
      status: 'completed',
      command: 'echo hi',
      output: 'hi',
      callId: 'call-1',
      toolName: 'shell',
    },
  ];

  const out = filterPendingCommandMessagesForApproval(messages, {
    callId: 'call-1',
    toolName: 'shell',
  });

  expect(out.length).toBe(2);
  expect(out.some((m) => m.sender === 'user')).toBe(true);
  expect(out.some((m) => m.status === 'completed')).toBe(true);
  expect(out.some((m) => m.status === 'running')).toBe(false);
});

it('filters pending/running command messages matching approval toolName when callId missing', () => {
  const messages = [
    {
      id: 'x',
      sender: 'command',
      status: 'running',
      command: 'apply_patch',
      output: '',
      toolName: 'apply_patch',
    },
    {
      id: 'y',
      sender: 'command',
      status: 'running',
      command: 'grep "foo" .',
      output: '',
      toolName: 'grep',
    },
  ];

  const out = filterPendingCommandMessagesForApproval(messages, {
    toolName: 'apply_patch',
  });

  expect(out.length).toBe(1);
  expect(out[0].toolName).toBe('grep');
});
