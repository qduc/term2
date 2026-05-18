import test from 'ava';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';

import { useConversation, type Message } from './use-conversation.js';

const loggingService = {
  debug() {},
  error() {},
} as any;

const conversationService = {} as any;

const Harness = ({ initialMessages }: { initialMessages: Message[] }) => {
  const { messages } = useConversation({
    conversationService,
    loggingService,
    initialMessages,
  });

  return <Text>{messages.map((message) => ('text' in message ? message.text : message.sender)).join('|')}</Text>;
};

test('useConversation initializes with restored messages', (t) => {
  const { lastFrame } = render(
    <Harness
      initialMessages={[
        { id: 'user-1', sender: 'user', text: 'previous question' },
        { id: 'bot-1', sender: 'bot', text: 'previous answer', status: 'finalized' },
      ]}
    />,
  );

  t.is(lastFrame(), 'previous question|previous answer');
});
