// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { useConversationMessages } from './use-conversation-messages.js';
import type { Message } from '../types/message.js';

type HarnessProps = { initialMessages?: Message[]; maxMessageCount?: number };
type HookResult = ReturnType<typeof useConversationMessages>;

// Box holds a fresh reference on every render so the caller always sees the
// latest hook return value. Tests are serial to avoid overlapping act() calls.
const renderHarness = async (props: HarnessProps = {}) => {
  const box: { current: HookResult | null } = { current: null };
  const Harness = () => {
    box.current = useConversationMessages({
      initialMessages: props.initialMessages,
      maxMessageCount: props.maxMessageCount,
    });
    return null;
  };
  await act(async () => {
    render(<Harness />);
  });
  if (!box.current) {
    throw new Error('Hook did not mount in time');
  }
  return box as { current: HookResult };
};

const run = async (callback: () => void) => {
  await act(async () => {
    callback();
  });
  // One extra act so React commits any scheduled re-render before assertions.
  await act(async () => {
    await Promise.resolve();
  });
};

test.serial('initializes with empty messages by default', async (t) => {
  const box = await renderHarness();
  t.is(box.current.messages.length, 0);
});

test.serial('initializes with provided initial messages', async (t) => {
  const box = await renderHarness({
    initialMessages: [
      { id: '1', sender: 'user', text: 'hello' } as Message,
      { id: '2', sender: 'bot', text: 'hi there' } as Message,
    ],
  });
  t.is(box.current.messages.length, 2);
});

test.serial('appendMessages adds messages', async (t) => {
  const box = await renderHarness();

  await run(() => {
    box.current.appendMessages([{ id: '1', sender: 'user', text: 'hello' } as Message]);
  });

  t.is(box.current.messages.length, 1);
  t.is(box.current.messages[0].sender, 'user');
});

test.serial('appendMessages ignores empty additions', async (t) => {
  const box = await renderHarness();

  await run(() => {
    box.current.appendMessages([]);
  });

  t.is(box.current.messages.length, 0);
});

test.serial('trimMessages enforces maxMessageCount', async (t) => {
  const box = await renderHarness({ maxMessageCount: 3 });

  await run(() => {
    box.current.appendMessages([
      { id: '1', sender: 'user', text: 'a' } as Message,
      { id: '2', sender: 'user', text: 'b' } as Message,
      { id: '3', sender: 'user', text: 'c' } as Message,
      { id: '4', sender: 'user', text: 'd' } as Message,
    ]);
  });

  t.is(box.current.messages.length, 3);
  t.is(box.current.messages[0].id, '2');
});

test.serial('addSystemMessage adds a system message', async (t) => {
  const box = await renderHarness();

  await run(() => {
    box.current.addSystemMessage('system instruction');
  });

  t.is(box.current.messages.length, 1);
  t.is(box.current.messages[0].sender, 'system');
  t.is((box.current.messages[0] as any).text, 'system instruction');
});

test.serial('addShellMessage adds a completed command message', async (t) => {
  const box = await renderHarness();

  await run(() => {
    box.current.addShellMessage('echo hi', 'hi', 0, false);
  });

  t.is(box.current.messages.length, 1);
  const msg = box.current.messages[0] as any;
  t.is(msg.sender, 'command');
  t.is(msg.status, 'completed');
  t.is(msg.command, 'echo hi');
  t.is(msg.output, 'hi');
  t.is(msg.success, true);
  t.is(msg.failureReason, undefined);
});

test.serial('addShellMessage adds a failed command message', async (t) => {
  const box = await renderHarness();

  await run(() => {
    box.current.addShellMessage('false', '', 1, false);
  });

  const msg = box.current.messages[0] as any;
  t.is(msg.status, 'failed');
  t.is(msg.success, false);
  t.is(msg.failureReason, 'exit 1');
});

test.serial('addShellMessage adds a timed-out command message', async (t) => {
  const box = await renderHarness();

  await run(() => {
    box.current.addShellMessage('sleep 100', '', null, true);
  });

  const msg = box.current.messages[0] as any;
  t.is(msg.status, 'failed');
  t.is(msg.success, false);
  t.is(msg.failureReason, 'timeout');
});

test.serial('addShellMessage handles null exitCode (error)', async (t) => {
  const box = await renderHarness();

  await run(() => {
    box.current.addShellMessage('bad-cmd', '', null, false);
  });

  const msg = box.current.messages[0] as any;
  t.is(msg.failureReason, 'error');
});

test.serial('getUserMessages returns user messages with indices', async (t) => {
  const box = await renderHarness({
    initialMessages: [
      { id: '1', sender: 'user', text: 'first' } as Message,
      { id: '2', sender: 'bot', text: 'response' } as Message,
      { id: '3', sender: 'user', text: 'second' } as Message,
    ],
  });

  const entries = box.current.getUserMessages();
  t.is(entries.length, 2);
  t.is(entries[0].uiIndex, 0);
  t.is(entries[0].text, 'first');
  t.is(entries[1].uiIndex, 2);
  t.is(entries[1].text, 'second');
});

test.serial('getUserMessages returns empty for no user messages', async (t) => {
  const box = await renderHarness({
    initialMessages: [{ id: '1', sender: 'bot', text: 'only bot' } as Message],
  });

  t.is(box.current.getUserMessages().length, 0);
});

test.serial('setMessages updates messages directly', async (t) => {
  const box = await renderHarness();

  await run(() => {
    box.current.setMessages([{ id: '1', sender: 'user', text: 'direct' } as Message]);
  });

  t.is(box.current.messages.length, 1);
  t.is(box.current.messages[0].sender, 'user');
});
