// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { Text } from 'ink';
import { renderInAct } from '../test-helpers/ink-testing.js';
import type { BackgroundTask } from '../services/subagents/subagent-notification-store.js';
import { useConversation } from './use-conversation.js';

const loggingService = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as any;

const historyService = { addMessage() {} };

it.sequential('useConversation observes background task snapshots for the composer UI', async () => {
  let observer: (() => void) | null = null;
  let tasks: readonly BackgroundTask[] = [];
  const conversationService = {
    sessionId: 'background-task-hook',
    backgroundSubagentTasks: {
      getSnapshot: () => tasks,
    },
    setBackgroundSubagentTaskObserver: (next: (() => void) | null) => {
      observer = next;
    },
  } as any;
  const Harness = () => {
    const { backgroundSubagentTasks } = useConversation({
      conversationService,
      loggingService,
      historyService,
    });
    return (
      <Text>
        {backgroundSubagentTasks
          .map((task) => `${task.kind === 'shell' ? 'shell' : task.role}:${task.status}`)
          .join(',') || 'empty'}
      </Text>
    );
  };

  const renderer = await renderInAct(<Harness />);
  expect(renderer.lastFrame() ?? '').toBe('empty');

  tasks = [
    {
      runId: 'run-1',
      role: 'worker',
      task: 'implement the overview',
      status: 'running',
      startedAt: 1_000,
    },
  ];
  act(() => observer?.());

  expect(renderer.lastFrame() ?? '').toBe('worker:running');

  act(() => renderer.unmount());
  expect(observer).toBeNull();
});

it.sequential('does not tick now for retained terminal background details after linger', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(1_000_000);
  try {
    const conversationService = {
      sessionId: 'retained-details',
      backgroundSubagentTasks: { getSnapshot: () => [] },
      setBackgroundSubagentTaskObserver: () => {},
      backgroundTaskControl: {
        listDetails: () => [
          {
            kind: 'shell',
            id: 'job-1',
            command: 'inbox-watch',
            status: 'cancelled',
            startedAt: 1_000,
            completedAt: 10_000,
          },
        ],
        listForegroundTransferCandidates: () => [],
      },
    } as any;

    const Harness = () => {
      const { backgroundTaskDetails, backgroundTaskDetailsNow } = useConversation({
        conversationService,
        loggingService,
        historyService,
      });
      return <Text>{`${backgroundTaskDetails.length}:${backgroundTaskDetailsNow}`}</Text>;
    };

    const renderer = await renderInAct(<Harness />);
    expect(renderer.lastFrame() ?? '').toBe('1:1000000');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(renderer.lastFrame() ?? '').toBe('1:1000000');
  } finally {
    vi.useRealTimers();
  }
});

it.sequential('ticks now while a turn is in flight even before task state is populated', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(1_000_000);
  try {
    const conversationService = {
      sessionId: 'in-flight-clock',
      abort: () => {},
      interruptFromUser: () => {},
      sendMessage: async () => new Promise(() => undefined),
      backgroundSubagentTasks: { getSnapshot: () => [] },
      setBackgroundSubagentTaskObserver: () => {},
      backgroundTaskControl: {
        listDetails: () => [],
        listForegroundTransferCandidates: () => [],
      },
    } as any;

    let sendMsg: ((input: string) => Promise<void>) | undefined;
    const Harness = () => {
      const { sendUserMessage, isProcessing, backgroundTaskDetailsNow } = useConversation({
        conversationService,
        loggingService,
        historyService,
      });
      sendMsg = sendUserMessage;
      return <Text>{`${isProcessing ? 'PROCESSING' : 'IDLE'}:${backgroundTaskDetailsNow}`}</Text>;
    };

    const renderer = await renderInAct(<Harness />);
    expect(renderer.lastFrame() ?? '').toBe('IDLE:1000000');

    await act(async () => {
      void sendMsg!('hello');
      await Promise.resolve();
    });
    expect(renderer.lastFrame() ?? '').toMatch(/^PROCESSING:/);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(renderer.lastFrame() ?? '').toBe('PROCESSING:1002000');
  } finally {
    vi.useRealTimers();
  }
});

it.sequential('keeps ticking now while a background task is still live', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(1_000_000);
  try {
    const conversationService = {
      sessionId: 'live-details',
      backgroundSubagentTasks: { getSnapshot: () => [] },
      setBackgroundSubagentTaskObserver: () => {},
      backgroundTaskControl: {
        listDetails: () => [
          {
            kind: 'shell',
            id: 'job-1',
            command: 'pnpm test',
            status: 'running',
            startedAt: 1_000,
          },
        ],
        listForegroundTransferCandidates: () => [],
      },
    } as any;

    const Harness = () => {
      const { backgroundTaskDetailsNow } = useConversation({
        conversationService,
        loggingService,
        historyService,
      });
      return <Text>{String(backgroundTaskDetailsNow)}</Text>;
    };

    const renderer = await renderInAct(<Harness />);
    expect(renderer.lastFrame() ?? '').toBe('1000000');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(renderer.lastFrame() ?? '').toBe('1002000');
  } finally {
    vi.useRealTimers();
  }
});
