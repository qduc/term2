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

test('useConversation triggers onClear and resets messages/sessionId', async (t) => {
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
