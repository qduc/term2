import { it, expect } from 'vitest';
import {
  annotateApprovedCommandMessage,
  filterPendingCommandMessagesForApproval,
  type ApprovedToolContext,
} from './approval-presentation-policy.js';

const allowAllCapabilities = () => ({
  annotateCommandMessage: true,
  hidePendingDuringPrompt: true,
});

it('filterPendingCommandMessagesForApproval prioritizes callId over toolName', () => {
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

  expect(out.length).toBe(1);
  expect(out[0].callId).toBe('call-1');
});

it('filterPendingCommandMessagesForApproval retains user and completed rows while hiding the matching running row', () => {
  const messages = [
    { id: 1, sender: 'user', text: 'hi' },
    {
      id: 'call-1-running',
      sender: 'command',
      status: 'running',
      command: 'echo hi',
      output: '',
      callId: 'call-1',
      toolName: 'shell',
    },
    {
      id: 'call-1-completed',
      sender: 'command',
      status: 'completed',
      command: 'echo hi',
      output: 'hi',
      callId: 'call-1',
      toolName: 'shell',
    },
  ];

  const out = filterPendingCommandMessagesForApproval(
    messages,
    { callId: 'call-1', toolName: 'shell' },
    allowAllCapabilities,
  );

  // Only the matching pending/running row is hidden; non-command and
  // completed rows stay visible.
  expect(out.length).toBe(2);
  expect(out.some((m) => m.sender === 'user')).toBe(true);
  expect(out.some((m) => m.sender === 'command' && m.status === 'completed')).toBe(true);
  expect(out.some((m) => m.sender === 'command' && m.status === 'running')).toBe(false);
});

it('filterPendingCommandMessagesForApproval falls back to toolName when callId missing', () => {
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

  expect(out.length).toBe(1);
  expect(out[0].toolName).toBe('grep');
});

it('annotateApprovedCommandMessage uses capability metadata instead of tool-name checks', () => {
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

  expect(output).toBeTruthy();
  expect(output.hadApproval === true).toBe(true);
});
