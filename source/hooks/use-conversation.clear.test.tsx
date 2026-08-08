// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act, useState } from 'react';
import { Text } from 'ink';
import { useConversation } from './use-conversation.js';
import { renderInAct } from '../test-helpers/ink-testing.js';

const loggingService = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as any;

type PublicConversationSend = ReturnType<typeof useConversation>['sendUserMessage'];

const assertPublicSendCannotBypassAdmission = (send: PublicConversationSend) => {
  // @ts-expect-error The surge bypass is workflow-owned and never public UI input.
  send({ text: 'not allowed' }, { bypassInputSurgeGuard: true });
};
void assertPublicSendCannotBypassAdmission;

it.sequential('useConversation triggers onClear and resets messages/sessionId', async () => {
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
      historyService: { addMessage() {} },
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

  const { lastFrame } = await renderInAct(<Harness />);
  expect(lastFrame).toBeTruthy();
  expect(lastFrame!()).toBe('old-session-id|1');

  await act(async () => {
    await clearFn();
  });

  expect(onClearCalled).toBe(true);
  expect(mockConversationService.sessionId).toBe('new-session-id');
  expect(lastFrame).toBeTruthy();
  expect(lastFrame!()).toBe('new-session-id|0');
});

it.sequential('useConversation fallback clear resets with a fresh session id', async () => {
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
      historyService: { addMessage() {} },
      initialMessages: [{ id: '1', sender: 'user', text: 'hello' }],
    });

    clearFn = clearConversation;

    return <Text>{messages.length}</Text>;
  };

  const { lastFrame } = await renderInAct(<Harness />);
  expect(lastFrame).toBeTruthy();
  expect(lastFrame!()).toBe('1');

  await act(async () => {
    await clearFn();
  });

  expect(mockConversationService.sessionId).not.toBe('old-session-id');
  expect(mockConversationService.sessionId).toBeTruthy();
  expect(lastFrame).toBeTruthy();
  expect(lastFrame!()).toBe('0');
});

it.sequential('useConversation filters duplicate stack trace from rawEvent when logging error', async () => {
  const loggedErrors: any[] = [];
  const loggingServiceMock = {
    debug() {},
    info() {},
    warn() {},
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
      historyService: { addMessage() {} },
    });
    sendMsg = sendUserMessage;
    return <Text>Harness</Text>;
  };

  await renderInAct(<Harness />);

  await act(async () => {
    try {
      await sendMsg!('hello');
    } catch {
      // Ignored in hook, error is handled and set in state/logged
    }
  });

  expect(loggedErrors.length).toBe(1);
  const meta = loggedErrors[0];
  expect(meta.error).toBe('Test error');
  expect(meta.stack).toBeTruthy();
});

it.sequential('useConversation exposes transient thinking state only while hidden reasoning is active', async () => {
  let emitTextDelta: (() => void) | undefined;
  let resolveSend: (() => void) | undefined;
  const mockConversationService = {
    sessionId: 'session-id',
    sendMessage: async (_input: string, options?: { onEvent?: (event: any) => void }) => {
      options?.onEvent?.({ type: 'reasoning_delta', delta: 'Thinking', fullText: 'Thinking' });
      emitTextDelta = () => {
        options?.onEvent?.({ type: 'text_delta', delta: 'Visible', fullText: 'Visible' });
      };
      await new Promise<void>((resolve) => {
        resolveSend = resolve;
      });
      return { type: 'response', response: 'Visible' } as any;
    },
  } as any;

  let sendMsg: ((input: string) => Promise<void>) | undefined;

  const Harness = () => {
    const { sendUserMessage, thinkingStartedAt } = useConversation({
      conversationService: mockConversationService,
      loggingService,
      historyService: { addMessage() {} },
    });
    sendMsg = sendUserMessage;
    return <Text>{thinkingStartedAt === null ? 'idle' : 'thinking'}</Text>;
  };

  const { lastFrame } = await renderInAct(<Harness />);

  expect(lastFrame!()).toBe('idle');

  let pendingSend: Promise<void> | undefined;
  await act(async () => {
    pendingSend = sendMsg!('hello');
    await Promise.resolve();
  });

  expect(lastFrame!()).toBe('thinking');

  await act(async () => {
    emitTextDelta?.();
  });

  expect(lastFrame!()).toBe('idle');

  await act(async () => {
    resolveSend?.();
    await pendingSend;
  });
});

it.sequential('useConversation adds a stopped message when processing is stopped', async () => {
  const mockConversationService = {
    sessionId: 'session-id',
    abort: () => {},
    interruptFromUser: () => {},
    setRetryCallback: () => {},
  } as any;

  let stopFn: (() => void) | undefined;

  const Harness = () => {
    const { stopProcessing, messages } = useConversation({
      conversationService: mockConversationService,
      loggingService,
      historyService: { addMessage() {} },
    });
    stopFn = stopProcessing;
    return <Text>{messages.map((message) => ('text' in message ? message.text : message.sender)).join('|')}</Text>;
  };

  const { lastFrame } = await renderInAct(<Harness />);
  expect(lastFrame!()).toBe('');

  await act(async () => {
    stopFn?.();
  });

  expect(lastFrame!()).toContain('Stopped');
});

it.sequential('useConversation cancels running shell messages when processing is stopped', async () => {
  let emitEvent: ((event: any) => void) | undefined;
  let resolveSend: (() => void) | undefined;
  const mockConversationService = {
    sessionId: 'session-id',
    abort: () => {},
    interruptFromUser: () => {},
    setRetryCallback: () => {},
    sendMessage: async (_input: string, options?: { onEvent?: (event: any) => void }) => {
      emitEvent = options?.onEvent;
      await new Promise<void>((resolve) => {
        resolveSend = resolve;
      });
      return { type: 'response', response: '' } as any;
    },
  } as any;

  let sendMsg: ((input: string) => Promise<void>) | undefined;
  let stopFn: (() => void) | undefined;

  const Harness = () => {
    const { sendUserMessage, stopProcessing, messages } = useConversation({
      conversationService: mockConversationService,
      loggingService,
      historyService: { addMessage() {} },
    });
    sendMsg = sendUserMessage;
    stopFn = stopProcessing;
    const commandStatuses = messages
      .filter((message) => message.sender === 'command')
      .map((message) => (message.sender === 'command' ? message.status : ''));
    return <Text>{commandStatuses.join('|')}</Text>;
  };

  const { lastFrame } = await renderInAct(<Harness />);
  let pendingSend: Promise<void> | undefined;
  await act(async () => {
    pendingSend = sendMsg!('run a command');
    await Promise.resolve();
    emitEvent?.({
      type: 'tool_started',
      toolCallId: 'shell-call-1',
      toolName: 'shell',
      arguments: { command: 'sleep 10' },
    });
  });

  expect(lastFrame!()).toBe('running');

  await act(async () => {
    stopFn?.();
  });

  expect(lastFrame!()).toBe('aborted');

  await act(async () => {
    resolveSend?.();
    await pendingSend;
  });
});

it.sequential('useConversation wires the retry callback to add a system message', async () => {
  let retryCallback: (() => void) | undefined;
  const mockConversationService = {
    sessionId: 'session-id',
    setRetryCallback(callback: () => void) {
      retryCallback = callback;
    },
  } as any;

  const Harness = () => {
    const { messages } = useConversation({
      conversationService: mockConversationService,
      loggingService,
      historyService: { addMessage() {} },
    });
    return <Text>{messages.map((message) => ('text' in message ? message.text : message.sender)).join('|')}</Text>;
  };

  const { lastFrame } = await renderInAct(<Harness />);
  expect(retryCallback).toBeTypeOf('function');

  await act(async () => {
    retryCallback?.();
  });

  expect(lastFrame!()).toContain('Retrying due to upstream error...');
});
