// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { useConversationMessages } from './use-conversation-messages.js';
import type { Message } from '../types/message.js';
import { renderInAct } from '../test-helpers/ink-testing.js';

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
  await renderInAct(<Harness />);
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

it.sequential('initializes with empty messages by default', async () => {
  const box = await renderHarness();
  expect(box.current.messages.length).toBe(0);
});

it.sequential('initializes with provided initial messages', async () => {
  const box = await renderHarness({
    initialMessages: [
      { id: '1', sender: 'user', text: 'hello' } as Message,
      { id: '2', sender: 'bot', text: 'hi there' } as Message,
    ],
  });
  expect(box.current.messages.length).toBe(2);
});

it.sequential('appendMessages adds messages', async () => {
  const box = await renderHarness();

  await run(() => {
    box.current.appendMessages([{ id: '1', sender: 'user', text: 'hello' } as Message]);
  });

  expect(box.current.messages.length).toBe(1);
  expect(box.current.messages[0].sender).toBe('user');
});

it.sequential('appendMessages ignores empty additions', async () => {
  const box = await renderHarness();

  await run(() => {
    box.current.appendMessages([]);
  });

  expect(box.current.messages.length).toBe(0);
});

it.sequential('trimMessages enforces maxMessageCount', async () => {
  const box = await renderHarness({ maxMessageCount: 3 });

  await run(() => {
    box.current.appendMessages([
      { id: '1', sender: 'user', text: 'a' } as Message,
      { id: '2', sender: 'user', text: 'b' } as Message,
      { id: '3', sender: 'user', text: 'c' } as Message,
      { id: '4', sender: 'user', text: 'd' } as Message,
    ]);
  });

  expect(box.current.messages.length).toBe(3);
  expect(box.current.messages[0].id).toBe('2');
});

it.sequential('addSystemMessage adds a system message', async () => {
  const box = await renderHarness();

  await run(() => {
    box.current.addSystemMessage('system instruction');
  });

  expect(box.current.messages.length).toBe(1);
  expect(box.current.messages[0].sender).toBe('system');
  expect((box.current.messages[0] as any).text).toBe('system instruction');
});

it.sequential('addShellMessage adds a completed command message', async () => {
  const box = await renderHarness();

  await run(() => {
    box.current.addShellMessage('echo hi', 'hi', 0, false);
  });

  expect(box.current.messages.length).toBe(1);
  const msg = box.current.messages[0] as any;
  expect(msg.sender).toBe('command');
  expect(msg.status).toBe('completed');
  expect(msg.command).toBe('echo hi');
  expect(msg.output).toBe('hi');
  expect(msg.success).toBe(true);
  expect(msg.failureReason).toBe(undefined);
});

it.sequential('addShellMessage adds a failed command message', async () => {
  const box = await renderHarness();

  await run(() => {
    box.current.addShellMessage('false', '', 1, false);
  });

  const msg = box.current.messages[0] as any;
  expect(msg.status).toBe('failed');
  expect(msg.success).toBe(false);
  expect(msg.failureReason).toBe('exit 1');
});

it.sequential('addShellMessage adds a timed-out command message', async () => {
  const box = await renderHarness();

  await run(() => {
    box.current.addShellMessage('sleep 100', '', null, true);
  });

  const msg = box.current.messages[0] as any;
  expect(msg.status).toBe('failed');
  expect(msg.success).toBe(false);
  expect(msg.failureReason).toBe('timeout');
});

it.sequential('addShellMessage handles null exitCode (error)', async () => {
  const box = await renderHarness();

  await run(() => {
    box.current.addShellMessage('bad-cmd', '', null, false);
  });

  const msg = box.current.messages[0] as any;
  expect(msg.failureReason).toBe('error');
});

it.sequential('getUserMessages returns user messages with indices', async () => {
  const box = await renderHarness({
    initialMessages: [
      { id: '1', sender: 'user', text: 'first' } as Message,
      { id: '2', sender: 'bot', text: 'response' } as Message,
      { id: '3', sender: 'user', text: 'second' } as Message,
    ],
  });

  const entries = box.current.getUserMessages();
  expect(entries.length).toBe(2);
  expect(entries[0].uiIndex).toBe(0);
  expect(entries[0].text).toBe('first');
  expect(entries[1].uiIndex).toBe(2);
  expect(entries[1].text).toBe('second');
});

it.sequential('getUserMessages returns empty for no user messages', async () => {
  const box = await renderHarness({
    initialMessages: [{ id: '1', sender: 'bot', text: 'only bot' } as Message],
  });

  expect(box.current.getUserMessages().length).toBe(0);
});

it.sequential('setMessages updates messages directly', async () => {
  const box = await renderHarness();

  await run(() => {
    box.current.setMessages([{ id: '1', sender: 'user', text: 'direct' } as Message]);
  });

  expect(box.current.messages.length).toBe(1);
  expect(box.current.messages[0].sender).toBe('user');
});
