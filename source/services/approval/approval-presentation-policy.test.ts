import test from 'ava';
import {
  annotateApprovedCommandMessage,
  filterPendingCommandMessagesForApproval,
  type ApprovedToolContext,
} from './approval-presentation-policy.js';

const allowAllCapabilities = () => ({
  annotateCommandMessage: true,
  hidePendingDuringPrompt: true,
});

test('filterPendingCommandMessagesForApproval prioritizes callId over toolName', (t) => {
  const messages = [
    {
      id: 'call-1-running',
      sender: 'command',
      status: 'running',
      command: 'echo one',
      output: '',
      callId: 'call-1',
      toolName: 'shell',
    },
    {
      id: 'call-2-running',
      sender: 'command',
      status: 'running',
      command: 'echo two',
      output: '',
      callId: 'call-2',
      toolName: 'shell',
    },
  ];

  const out = filterPendingCommandMessagesForApproval(
    messages,
    { callId: 'call-2', toolName: 'shell' },
    allowAllCapabilities,
  );

  t.is(out.length, 1);
  t.is(out[0].callId, 'call-1');
});

test('filterPendingCommandMessagesForApproval falls back to toolName when callId missing', (t) => {
  const messages = [
    {
      id: 'apply-running',
      sender: 'command',
      status: 'running',
      command: 'apply patch',
      output: '',
      toolName: 'apply_patch',
    },
    {
      id: 'grep-running',
      sender: 'command',
      status: 'running',
      command: 'grep foo',
      output: '',
      toolName: 'grep',
    },
  ];

  const out = filterPendingCommandMessagesForApproval(messages, { toolName: 'apply_patch' }, allowAllCapabilities);

  t.is(out.length, 1);
  t.is(out[0].toolName, 'grep');
});

test('annotateApprovedCommandMessage uses capability metadata instead of tool-name checks', (t) => {
  const context: ApprovedToolContext = {
    callId: 'call-annotate-1',
    toolName: 'custom_tool',
  };

  const output = annotateApprovedCommandMessage(
    {
      id: 'msg-1',
      sender: 'command',
      status: 'completed',
      command: 'custom',
      output: 'ok',
      callId: 'call-annotate-1',
      toolName: 'custom_tool',
    },
    context,
    (toolName) =>
      toolName === 'custom_tool'
        ? { annotateCommandMessage: true, hidePendingDuringPrompt: false }
        : { annotateCommandMessage: false, hidePendingDuringPrompt: false },
  );

  t.truthy(output);
  t.true(output.hadApproval === true);
});
