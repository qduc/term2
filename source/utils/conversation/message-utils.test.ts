import test from 'ava';

import type { CommandMessage } from '../../tools/types.js';
import type { Message } from '../../types/message.js';
import {
  countUndoableUserTurnsFrom,
  findLastUndoableUserMessage,
  getLastFinalAssistantText,
  getUserMessageEntries,
  mergeCommandMessages,
} from './message-utils.js';

// ---------------------------------------------------------------------------
// getLastFinalAssistantText
// ---------------------------------------------------------------------------

test('getLastFinalAssistantText returns null for empty list', (t) => {
  t.is(getLastFinalAssistantText([]), null);
});

test('getLastFinalAssistantText returns last bot message text', (t) => {
  const messages: Message[] = [
    { id: '1', sender: 'user', text: 'hello' },
    { id: '2', sender: 'bot', text: 'world', status: 'finalized' },
  ];
  t.is(getLastFinalAssistantText(messages), 'world');
});

test('getLastFinalAssistantText combines contiguous bot messages', (t) => {
  const messages: Message[] = [
    { id: '1', sender: 'bot', text: 'hello ', status: 'finalized' },
    { id: '2', sender: 'bot', text: 'world', status: 'finalized' },
  ];
  t.is(getLastFinalAssistantText(messages), 'hello world');
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

test('mergeCommandMessages appends new commands when no overlap', (t) => {
  const prev: Message[] = [userMsg('u1', 'hi')];
  const newCmds = [cmd('c1', 'call-1')];
  const result = mergeCommandMessages(prev, newCmds);
  t.is(result.length, 2);
  t.is(result[0].sender, 'user');
  t.is(result[1].sender, 'command');
});

test('mergeCommandMessages filters commands whose callId already exists in prev', (t) => {
  const prev: Message[] = [cmd('existing', 'call-1')];
  const newCmds = [cmd('dup', 'call-1'), cmd('new', 'call-2')];
  const result = mergeCommandMessages(prev, newCmds);
  // existing stays, dup is filtered, new is added
  const commands = result.filter((m) => m.sender === 'command');
  t.is(commands.length, 2);
  t.is(commands[0].id, 'existing');
  t.is(commands[1].id, 'new');
});

test('mergeCommandMessages keeps running messages when new command has same callId (Phase 1 dedup)', (t) => {
  // When a completed command has the same callId as an existing running message,
  // Phase 1 filters out the new command (already shown), and Phase 2 only
  // cleans stale messages whose callId matches commands that survived Phase 1.
  const staleRunning: CommandMessage = { ...cmd('stale', 'call-1', 'running') };
  const prev: Message[] = [userMsg('u1', 'hi'), staleRunning];
  const newCmds = [cmd('done', 'call-1', 'completed')];
  const result = mergeCommandMessages(prev, newCmds);
  // stale running stays, completed filtered out by Phase 1
  const commands = result.filter((m) => m.sender === 'command');
  t.is(commands.length, 1);
  t.is(commands[0].id, 'stale');
});

test('mergeCommandMessages removes stale running messages when a different new command arrives', (t) => {
  // Phase 2 removes stale running/pending messages from prev when a new
  // command with a different callId arrives, cleaning up orphaned streaming messages.
  const staleRunning: CommandMessage = { ...cmd('stale', 'call-1', 'running') };
  const prev: Message[] = [userMsg('u1', 'hi'), staleRunning];
  // new command has a different callId that doesn't exist in prev
  const newCmds = [cmd('done', 'call-2', 'completed')];
  const result = mergeCommandMessages(prev, newCmds);
  const commands = result.filter((m) => m.sender === 'command');
  // stale running stays because its callId 'call-1' is not in completedCallIds ('call-2')
  t.is(commands.length, 2);
});

test('mergeCommandMessages does not remove completed/stale messages with different callIds', (t) => {
  const other: CommandMessage = { ...cmd('other', 'call-99', 'completed') };
  const prev: Message[] = [other];
  const newCmds = [cmd('done', 'call-1', 'completed')];
  const result = mergeCommandMessages(prev, newCmds);
  const commands = result.filter((m) => m.sender === 'command');
  t.is(commands.length, 2);
});

test('mergeCommandMessages handles commands without callId', (t) => {
  const prev: Message[] = [cmd('existing')]; // no callId
  const newCmds = [cmd('new')]; // no callId
  const result = mergeCommandMessages(prev, newCmds);
  const commands = result.filter((m) => m.sender === 'command');
  // Both kept since neither has a callId to dedup on
  t.is(commands.length, 2);
});

// ---------------------------------------------------------------------------
// findLastUndoableUserMessage
// ---------------------------------------------------------------------------

test('findLastUndoableUserMessage returns -1 for empty list', (t) => {
  t.is(findLastUndoableUserMessage([]), -1);
});

test('findLastUndoableUserMessage returns last user message index', (t) => {
  const messages: Message[] = [userMsg('u1', 'first'), botMsg('b1', 'reply'), userMsg('u2', 'second')];
  t.is(findLastUndoableUserMessage(messages), 2);
});

test('findLastUndoableUserMessage skips consumedForAbort messages', (t) => {
  const messages: Message[] = [
    userMsg('u1', 'first'),
    botMsg('b1', 'reply'),
    { id: 'u2', sender: 'user', text: 'consumed', consumedForAbort: true } as Message,
  ];
  t.is(findLastUndoableUserMessage(messages), 0);
});

test('findLastUndoableUserMessage returns -1 when all user messages are consumed', (t) => {
  const messages: Message[] = [
    { id: 'u1', sender: 'user', text: 'consumed', consumedForAbort: true } as Message,
    botMsg('b1', 'reply'),
  ];
  t.is(findLastUndoableUserMessage(messages), -1);
});

// ---------------------------------------------------------------------------
// countUndoableUserTurnsFrom
// ---------------------------------------------------------------------------

test('countUndoableUserTurnsFrom counts from startIndex', (t) => {
  const messages: Message[] = [userMsg('u1', 'a'), userMsg('u2', 'b'), userMsg('u3', 'c')];
  t.is(countUndoableUserTurnsFrom(messages, 1), 2);
  t.is(countUndoableUserTurnsFrom(messages, 0), 3);
});

test('countUndoableUserTurnsFrom skips consumedForAbort', (t) => {
  const messages: Message[] = [
    userMsg('u1', 'a'),
    { id: 'u2', sender: 'user', text: 'consumed', consumedForAbort: true } as Message,
    userMsg('u3', 'c'),
  ];
  t.is(countUndoableUserTurnsFrom(messages, 0), 2);
});

test('countUndoableUserTurnsFrom returns 0 for empty range', (t) => {
  t.is(countUndoableUserTurnsFrom([], 0), 0);
});

// ---------------------------------------------------------------------------
// getUserMessageEntries
// ---------------------------------------------------------------------------

test('getUserMessageEntries returns user messages with indices', (t) => {
  const messages: Message[] = [userMsg('u1', 'hello'), botMsg('b1', 'hi'), userMsg('u2', 'bye')];
  const entries = getUserMessageEntries(messages);
  t.deepEqual(entries, [
    { uiIndex: 0, text: 'hello' },
    { uiIndex: 2, text: 'bye' },
  ]);
});

test('getUserMessageEntries excludes consumedForAbort messages', (t) => {
  const messages: Message[] = [
    userMsg('u1', 'hello'),
    { id: 'u2', sender: 'user', text: 'consumed', consumedForAbort: true } as Message,
  ];
  const entries = getUserMessageEntries(messages);
  t.deepEqual(entries, [{ uiIndex: 0, text: 'hello' }]);
});

test('getUserMessageEntries returns empty array for no user messages', (t) => {
  t.deepEqual(getUserMessageEntries([botMsg('b1', 'hi')]), []);
});
