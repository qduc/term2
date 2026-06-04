// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act, useState } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { useConversation } from './use-conversation.js';

const loggingService = {
  debug() {},
  error() {},
} as any;

test.serial('useConversation triggers onClear and resets messages/sessionId', async (t) => {
  let onClearCalled = false;
  const mockConversationService = {
    sessionId: 'old-session-id',
    resetWithNewId(newId: string) {
      this.sessionId = newId;
    },
  } as any;

  let clearFn: () => Promise<void> = () => Promise.resolve();

  const Harness = () => {
    const [sessionIdState, setSessionIdState] = useState('old-session-id');
    const { messages, clearConversation, sessionId } = useConversation({
      conversationService: mockConversationService,
      loggingService,
      initialMessages: [{ id: '1', sender: 'user', text: 'hello' }],
      sessionId: sessionIdState,
      onClear: async () => {
        onClearCalled = true;
        setSessionIdState('new-session-id');
        mockConversationService.resetWithNewId('new-session-id');
      },
    });

    clearFn = clearConversation;

    return (
      <Text>
        {sessionId}|{messages.length}
      </Text>
    );
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<Harness />));
  });
  t.truthy(lastFrame);
  t.is(lastFrame!(), 'old-session-id|1');

  await act(async () => {
    await clearFn();
  });

  t.true(onClearCalled);
  t.is(mockConversationService.sessionId, 'new-session-id');
  t.truthy(lastFrame);
  t.is(lastFrame!(), 'new-session-id|0');
});

test.serial('useConversation fallback clear resets with a fresh session id', async (t) => {
  const mockConversationService = {
    sessionId: 'old-session-id',
    resetWithNewId(newId: string) {
      this.sessionId = newId;
    },
  } as any;

  let clearFn: () => Promise<void> = () => Promise.resolve();

  const Harness = () => {
    const { messages, clearConversation } = useConversation({
      conversationService: mockConversationService,
      loggingService,
      initialMessages: [{ id: '1', sender: 'user', text: 'hello' }],
    });

    clearFn = clearConversation;

    return <Text>{messages.length}</Text>;
  };

  let lastFrame: (() => string | undefined) | undefined;
  await act(async () => {
    ({ lastFrame } = render(<Harness />));
  });
  t.truthy(lastFrame);
  t.is(lastFrame!(), '1');

  await act(async () => {
    await clearFn();
  });

  t.not(mockConversationService.sessionId, 'old-session-id');
  t.truthy(mockConversationService.sessionId);
  t.truthy(lastFrame);
  t.is(lastFrame!(), '0');
});

test.serial('useConversation filters duplicate stack trace from rawEvent when logging error', async (t) => {
  const loggedErrors: any[] = [];
  const loggingServiceMock = {
    debug() {},
    error(_msg: string, meta?: any) {
      loggedErrors.push(meta);
    },
  } as any;

  const errorWithRawEvent = new Error('Test error');
  (errorWithRawEvent as any).rawEvent = {
    type: 'error',
    message: 'Test error',
    stack: 'Error: Test error\n    at dummy (file.ts:1:1)',
  };

  const mockConversationService = {
    sessionId: 'session-id',
    sendMessage: async () => {
      throw errorWithRawEvent;
    },
  } as any;

  let sendMsg: ((input: string) => Promise<void>) | undefined;

  const Harness = () => {
    const { sendUserMessage } = useConversation({
      conversationService: mockConversationService,
      loggingService: loggingServiceMock,
    });
    sendMsg = sendUserMessage;
    return <Text>Harness</Text>;
  };

  await act(async () => {
    render(<Harness />);
  });

  await act(async () => {
    try {
      await sendMsg!('hello');
    } catch {
      // Ignored in hook, error is handled and set in state/logged
    }
  });

  t.is(loggedErrors.length, 1);
  const meta = loggedErrors[0];
  t.is(meta.error, 'Test error');
  t.truthy(meta.stack);
  t.truthy(meta.rawEvent);
  t.is(meta.rawEvent.stack, undefined);
  t.is(meta.rawEvent.message, 'Test error');
});
