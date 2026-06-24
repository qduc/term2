import { it, expect } from 'vitest';
import type { CommandMessage } from '../../tools/types.js';
import type { Message } from '../../types/message.js';
import {
  countUndoableUserTurnsFrom,
  findLastUndoableUserMessage,
  getLastFinalAssistantText,
  getUserMessageEntries,
  mergeCommandMessages,
  trimTrailingAssistantMessages,
} from './message-utils.js';

// ---------------------------------------------------------------------------
// getLastFinalAssistantText
// ---------------------------------------------------------------------------

it('getLastFinalAssistantText returns null for empty list', () => {
  expect(getLastFinalAssistantText([])).toBe(null);
});

it('getLastFinalAssistantText returns last bot message text', () => {
  const messages: Message[] = [
    { id: '1', sender: 'user', text: 'hello' },
    { id: '2', sender: 'bot', text: 'world', status: 'finalized' },
  ];
  expect(getLastFinalAssistantText(messages)).toBe('world');
});

it('getLastFinalAssistantText combines contiguous bot messages', () => {
  const messages: Message[] = [
    { id: '1', sender: 'bot', text: 'hello ', status: 'finalized' },
    { id: '2', sender: 'bot', text: 'world', status: 'finalized' },
  ];
  expect(getLastFinalAssistantText(messages)).toBe('hello world');
});

// ---------------------------------------------------------------------------
// trimTrailingAssistantMessages
// ---------------------------------------------------------------------------

it('trimTrailingAssistantMessages removes trailing assistant messages', () => {
  const messages: Message[] = [
    userMsg('u1', 'hello'),
    { id: 'r1', sender: 'reasoning', text: 'thinking', status: 'finalized' },
    botMsg('b1', 'answer'),
  ];

  expect(trimTrailingAssistantMessages(messages)).toEqual([userMsg('u1', 'hello')]);
});

it('trimTrailingAssistantMessages keeps trailing user messages intact', () => {
  const messages: Message[] = [
    userMsg('u1', 'hello'),
    { id: 'a1', sender: 'bot', text: 'answer' },
    userMsg('u2', 'follow up'),
  ];

  expect(trimTrailingAssistantMessages(messages)).toBe(messages);
});

it('trimTrailingAssistantMessages removes trailing command messages for /retry tool rewind', () => {
  const messages: Message[] = [
    userMsg('u1', 'hello'),
    {
      id: 'c1',
      sender: 'command',
      status: 'completed',
      command: 'date',
      output: 'Mon Jan 01 00:00:00 UTC 2024',
    } as CommandMessage,
    botMsg('b1', 'answer'),
  ];

  expect(trimTrailingAssistantMessages(messages)).toEqual([userMsg('u1', 'hello')]);
});

// ---------------------------------------------------------------------------
// mergeCommandMessages
// ---------------------------------------------------------------------------

function cmd(id: string, callId?: string, status: CommandMessage['status'] = 'completed'): CommandMessage {
  return {
    id,
    sender: 'command',
    status,
    command: `cmd-${id}`,
    output: '',
    callId,
  };
}

function userMsg(id: string, text: string): Message {
  return { id, sender: 'user', text };
}

function botMsg(id: string, text: string): Message {
  return { id, sender: 'bot', text, status: 'finalized' };
}

it('mergeCommandMessages appends new commands when no overlap', () => {
  const prev: Message[] = [userMsg('u1', 'hi')];
  const newCmds = [cmd('c1', 'call-1')];
  const result = mergeCommandMessages(prev, newCmds);
  expect(result.length).toBe(2);
  expect(result[0].sender).toBe('user');
  expect(result[1].sender).toBe('command');
});

it('mergeCommandMessages filters commands whose callId already exists in prev', () => {
  const prev: Message[] = [cmd('existing', 'call-1')];
  const newCmds = [cmd('dup', 'call-1'), cmd('new', 'call-2')];
  const result = mergeCommandMessages(prev, newCmds);
  // existing stays, dup is filtered, new is added
  const commands = result.filter((m) => m.sender === 'command');
  expect(commands.length).toBe(2);
  expect(commands[0].id).toBe('existing');
  expect(commands[1].id).toBe('new');
});

it('mergeCommandMessages keeps running messages when new command has same callId (Phase 1 dedup)', () => {
  // When a completed command has the same callId as an existing running message,
  // Phase 1 filters out the new command (already shown), and Phase 2 only
  // cleans stale messages whose callId matches commands that survived Phase 1.
  const staleRunning: CommandMessage = { ...cmd('stale', 'call-1', 'running') };
  const prev: Message[] = [userMsg('u1', 'hi'), staleRunning];
  const newCmds = [cmd('done', 'call-1', 'completed')];
  const result = mergeCommandMessages(prev, newCmds);
  // stale running stays, completed filtered out by Phase 1
  const commands = result.filter((m) => m.sender === 'command');
  expect(commands.length).toBe(1);
  expect(commands[0].id).toBe('stale');
});

it('mergeCommandMessages removes stale running messages when a different new command arrives', () => {
  // Phase 2 removes stale running/pending messages from prev when a new
  // command with a different callId arrives, cleaning up orphaned streaming messages.
  const staleRunning: CommandMessage = { ...cmd('stale', 'call-1', 'running') };
  const prev: Message[] = [userMsg('u1', 'hi'), staleRunning];
  // new command has a different callId that doesn't exist in prev
  const newCmds = [cmd('done', 'call-2', 'completed')];
  const result = mergeCommandMessages(prev, newCmds);
  const commands = result.filter((m) => m.sender === 'command');
  // stale running stays because its callId 'call-1' is not in completedCallIds ('call-2')
  expect(commands.length).toBe(2);
});

it('mergeCommandMessages does not remove completed/stale messages with different callIds', () => {
  const other: CommandMessage = { ...cmd('other', 'call-99', 'completed') };
  const prev: Message[] = [other];
  const newCmds = [cmd('done', 'call-1', 'completed')];
  const result = mergeCommandMessages(prev, newCmds);
  const commands = result.filter((m) => m.sender === 'command');
  expect(commands.length).toBe(2);
});

it('mergeCommandMessages handles commands without callId', () => {
  const prev: Message[] = [cmd('existing')]; // no callId
  const newCmds = [cmd('new')]; // no callId
  const result = mergeCommandMessages(prev, newCmds);
  const commands = result.filter((m) => m.sender === 'command');
  // Both kept since neither has a callId to dedup on
  expect(commands.length).toBe(2);
});

// ---------------------------------------------------------------------------
// findLastUndoableUserMessage
// ---------------------------------------------------------------------------

it('findLastUndoableUserMessage returns -1 for empty list', () => {
  expect(findLastUndoableUserMessage([])).toBe(-1);
});

it('findLastUndoableUserMessage returns last user message index', () => {
  const messages: Message[] = [userMsg('u1', 'first'), botMsg('b1', 'reply'), userMsg('u2', 'second')];
  expect(findLastUndoableUserMessage(messages)).toBe(2);
});

it('findLastUndoableUserMessage skips consumedForAbort messages', () => {
  const messages: Message[] = [
    userMsg('u1', 'first'),
    botMsg('b1', 'reply'),
    { id: 'u2', sender: 'user', text: 'consumed', consumedForAbort: true } as Message,
  ];
  expect(findLastUndoableUserMessage(messages)).toBe(0);
});

it('findLastUndoableUserMessage returns -1 when all user messages are consumed', () => {
  const messages: Message[] = [
    { id: 'u1', sender: 'user', text: 'consumed', consumedForAbort: true } as Message,
    botMsg('b1', 'reply'),
  ];
  expect(findLastUndoableUserMessage(messages)).toBe(-1);
});

// ---------------------------------------------------------------------------
// countUndoableUserTurnsFrom
// ---------------------------------------------------------------------------

it('countUndoableUserTurnsFrom counts from startIndex', () => {
  const messages: Message[] = [userMsg('u1', 'a'), userMsg('u2', 'b'), userMsg('u3', 'c')];
  expect(countUndoableUserTurnsFrom(messages, 1)).toBe(2);
  expect(countUndoableUserTurnsFrom(messages, 0)).toBe(3);
});

it('countUndoableUserTurnsFrom skips consumedForAbort', () => {
  const messages: Message[] = [
    userMsg('u1', 'a'),
    { id: 'u2', sender: 'user', text: 'consumed', consumedForAbort: true } as Message,
    userMsg('u3', 'c'),
  ];
  expect(countUndoableUserTurnsFrom(messages, 0)).toBe(2);
});

it('countUndoableUserTurnsFrom returns 0 for empty range', () => {
  expect(countUndoableUserTurnsFrom([], 0)).toBe(0);
});

// ---------------------------------------------------------------------------
// getUserMessageEntries
// ---------------------------------------------------------------------------

it('getUserMessageEntries returns user messages with indices', () => {
  const messages: Message[] = [userMsg('u1', 'hello'), botMsg('b1', 'hi'), userMsg('u2', 'bye')];
  const entries = getUserMessageEntries(messages);
  expect(entries).toEqual([
    { uiIndex: 0, text: 'hello' },
    { uiIndex: 2, text: 'bye' },
  ]);
});

it('getUserMessageEntries excludes consumedForAbort messages', () => {
  const messages: Message[] = [
    userMsg('u1', 'hello'),
    { id: 'u2', sender: 'user', text: 'consumed', consumedForAbort: true } as Message,
  ];
  const entries = getUserMessageEntries(messages);
  expect(entries).toEqual([{ uiIndex: 0, text: 'hello' }]);
});

it('getUserMessageEntries returns empty array for no user messages', () => {
  expect(getUserMessageEntries([botMsg('b1', 'hi')])).toEqual([]);
});
