// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import { Text } from 'ink';

import { useConversation, type Message } from './use-conversation.js';
import { renderInAct } from '../test-helpers/ink-testing.js';

const loggingService = {
  debug() {},
  error() {},
} as any;

const conversationService = {} as any;

const Harness = ({ initialMessages }: { initialMessages: Message[] }) => {
  const { messages, lastUsage } = useConversation({
    conversationService,
    loggingService,
    initialMessages,
  });

  return (
    <Text>
      {messages.map((message) => ('text' in message ? message.text : message.sender)).join('|')}
      {'\n'}
      {JSON.stringify(lastUsage)}
    </Text>
  );
};

test.serial('useConversation initializes with restored messages', async (t) => {
  const { lastFrame } = await renderInAct(
    <Harness
      initialMessages={[
        { id: 'user-1', sender: 'user', text: 'previous question' },
        { id: 'bot-1', sender: 'bot', text: 'previous answer', status: 'finalized' },
      ]}
    />,
    t,
  );

  t.is(lastFrame(), 'previous question|previous answer\nnull');
});

test.serial('useConversation initializes lastUsage from the last restored assistant message', async (t) => {
  const { lastFrame } = await renderInAct(
    <Harness
      initialMessages={[
        {
          id: 'bot-1',
          sender: 'bot',
          text: 'earlier answer',
          status: 'finalized',
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
        { id: 'user-1', sender: 'user', text: 'follow-up' },
        {
          id: 'bot-2',
          sender: 'bot',
          text: 'latest answer',
          status: 'finalized',
          usage: { prompt_tokens: 1200, completion_tokens: 350, cache_read_tokens: 900, total_tokens: 1550 },
        },
      ]}
    />,
    t,
  );

  t.is(
    lastFrame(),
    'earlier answer|follow-up|latest answer\n{"prompt_tokens":1200,"completion_tokens":350,"cache_read_tokens":900,"total_tokens":1550}',
  );
});
