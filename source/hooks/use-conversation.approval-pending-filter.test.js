import test from 'ava';
import { filterPendingCommandMessagesForApproval } from '../../dist/hooks/use-conversation.js';

test('filters pending/running command messages matching approval callId', (t) => {
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

  t.is(out.length, 2);
  t.true(out.some((m) => m.sender === 'user'));
  t.true(out.some((m) => m.status === 'completed'));
  t.false(out.some((m) => m.status === 'running'));
});

test('filters pending/running command messages matching approval toolName when callId missing', (t) => {
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

  t.is(out.length, 1);
  t.is(out[0].toolName, 'grep');
});
