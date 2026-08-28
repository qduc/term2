// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// TEMPORARY verification probe for the "Stopped + processing.." bug report.
// Reproduces: turn in flight -> stopProcessingWithNotice -> turn promise NOT yet
// settled. Asserts the isProcessing flag and transcript at that instant.
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

it.sequential('PROBE: stop while turn promise unsettled — isProcessing flag and transcript', async () => {
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

  const Harness = () => {
    const { sendUserMessage, stopProcessing, isProcessing, messages } = useConversation({
      conversationService: mockConversationService,
      loggingService,
      historyService: { addMessage() {} },
    });
    sendMsg = sendUserMessage;
    stopFn = stopProcessing;
    const transcript = messages.map((m) => ('text' in m ? m.text : m.sender)).join('|');
    return <Text>{`${isProcessing ? 'PROCESSING' : 'IDLE'}::${transcript}`}</Text>;
  };

  const { lastFrame } = await renderInAct(<Harness />);
  expect(lastFrame!()).toBe('IDLE::');

  let pendingSend: Promise<void> | undefined;
  await act(async () => {
    pendingSend = sendMsg!('hello');
    await Promise.resolve();
  });
  // Turn started, spinner should be up.
  console.log('after send:', lastFrame!());
  expect(lastFrame!()).toBe('PROCESSING::hello');

  // User presses double-Escape: stopProcessingWithNotice runs, but the turn
  // promise is still parked (unresolved) — this is the report's exact window.
  await act(async () => {
    stopFn?.();
  });
  console.log('immediately after stop (turn promise unsettled):', lastFrame!());

  // Now unwind the aborted turn like the real transport would.
  await act(async () => {
    resolveSend?.();
    await pendingSend;
  });
  console.log('after turn promise settles:', lastFrame!());

  expect(lastFrame!()).toBe('IDLE::hello|Stopped');
});
