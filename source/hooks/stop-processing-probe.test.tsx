// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Regression coverage for stopping a turn before its transport promise settles.
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { Text } from 'ink';
import { useConversation } from './use-conversation.js';
import { renderInAct } from '../test-helpers/ink-testing.js';

const loggingService = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as any;

it.sequential('stopping an unsettled turn leaves the UI idle with a stopped notice', async () => {
  let resolveSend: (() => void) | undefined;
  const mockConversationService = {
    sessionId: 'session-id',
    abort: () => {},
    interruptFromUser: () => {},
    setRetryCallback: () => {},
    sendMessage: async (_input: unknown, _options?: unknown) => {
      await new Promise<void>((resolve) => {
        resolveSend = resolve;
      });
      return { type: 'response', response: '' } as any;
    },
  } as any;

  let sendMsg: ((input: string) => Promise<void>) | undefined;
  let stopFn: (() => void) | undefined;
  let latestTranscript: string | undefined;

  const Harness = () => {
    const { sendUserMessage, stopProcessing, isProcessing, messages } = useConversation({
      conversationService: mockConversationService,
      loggingService,
      historyService: { addMessage() {} },
    });
    sendMsg = sendUserMessage;
    stopFn = stopProcessing;
    const transcript = messages.map((m) => ('text' in m ? m.text : m.sender)).join('|');
    latestTranscript = `${isProcessing ? 'PROCESSING' : 'IDLE'}::${transcript}`;
    return <Text>{`${isProcessing ? 'PROCESSING' : 'IDLE'}::${transcript}`}</Text>;
  };

  const { lastFrame } = await renderInAct(<Harness />);
  expect(lastFrame!()).toBe('IDLE::');

  let sendSettled = false;
  let pendingSend: Promise<void> | undefined;
  await act(async () => {
    pendingSend = sendMsg!('hello').then(() => {
      sendSettled = true;
    });
    await Promise.resolve();
  });
  expect(lastFrame!()).toBe('PROCESSING::hello');

  // Stop while the transport promise is still parked. The UI must settle
  // immediately rather than waiting for the transport to finish.
  await act(async () => {
    stopFn?.();
  });
  expect(lastFrame!()).toBe('IDLE::hello|Stopped');

  // Unwind the transport after the UI has already settled. This must not undo
  // the stopped state or leave the promise hanging.
  await act(async () => {
    resolveSend?.();
    await pendingSend;
  });
  expect(sendSettled).toBe(true);
  expect(latestTranscript).toBe('IDLE::hello|Stopped');
});
