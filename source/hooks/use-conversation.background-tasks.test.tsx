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

it.sequential('retargets a nested rejection composer when a background approval arrives', async () => {
  let backgroundListener: (() => void) | null = null;
  let nestedObserver: ((snapshot: any) => void) | null = null;
  let backgroundSnapshot: any = { revision: 0, current: null, pendingCount: 0, closed: false };
  const nestedSnapshot = {
    requestId: 'nested-1',
    sessionId: 'session-1',
    outerRunId: 'run-1',
    nestedCallId: 'nested-1',
    toolName: 'create_file',
    preparedArguments: { path: '/outside/nested.txt' },
    authorityContext: {},
    approval: { agentName: 'Nested', toolName: 'create_file', argumentsText: '{}', rawInterruption: null },
  };
  const conversationService = {
    sessionId: 'rejection-owner-hook',
    backgroundSubagentTasks: { getSnapshot: () => [] },
    setBackgroundSubagentTaskObserver: () => {},
    backgroundTaskControl: { listDetails: () => [], listForegroundTransferCandidates: () => [] },
    backgroundSubagentApprovals: {
      getSnapshot: () => backgroundSnapshot,
      subscribe: (listener: () => void) => {
        backgroundListener = listener;
        return () => {
          backgroundListener = null;
        };
      },
    },
    getNestedApprovalSnapshot: () => nestedSnapshot,
    setNestedApprovalObserver: (observer: ((snapshot: any) => void) | null) => {
      nestedObserver = observer;
    },
    setPendingInteractionObserver: () => {},
    setRetryCallback: () => {},
  } as any;
  let setReason: (value: boolean) => void = () => {};
  let current: { waiting: boolean; nested: any } = { waiting: false, nested: null };
  const Harness = () => {
    const state = useConversation({ conversationService, loggingService, historyService });
    setReason = state.setWaitingForRejectionReason;
    current = { waiting: state.waitingForRejectionReason, nested: state.nestedApproval };
    return <Text>{state.waitingForRejectionReason ? 'reason' : 'idle'}</Text>;
  };

  const renderer = await renderInAct(<Harness />);
  expect(renderer.lastFrame()).toBe('idle');
  act(() => setReason(true));
  expect(renderer.lastFrame()).toBe('reason');

  backgroundSnapshot = {
    revision: 1,
    current: { runId: 'background-1', generation: 1, toolCallId: 'b1', toolName: 'create_file', argumentsText: '{}' },
    pendingCount: 1,
    closed: false,
  };
  act(() => backgroundListener?.());

  expect(renderer.lastFrame()).toBe('reason');
  expect(current.nested).toEqual(nestedSnapshot);
  expect(nestedObserver).toBeTruthy();
  act(() => renderer.unmount());
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

it.sequential('triggers notifier.approvalNeeded when background subagent approvals are pending', async () => {
  let subscriber: (() => void) | null = null;
  let snapshot: any = { pendingCount: 0, pending: [] };
  const conversationService = {
    sessionId: 'approval-notify',
    backgroundSubagentTasks: { getSnapshot: () => [] },
    setBackgroundSubagentTaskObserver: () => {},
    backgroundSubagentApprovals: {
      getSnapshot: () => snapshot,
      subscribe: (cb: () => void) => {
        subscriber = cb;
        return () => {
          subscriber = null;
        };
      },
    },
    backgroundTaskControl: {
      listDetails: () => [],
      listForegroundTransferCandidates: () => [],
    },
  } as any;

  const notifier = {
    turnComplete: vi.fn(),
    approvalNeeded: vi.fn(),
  };

  const Harness = () => {
    useConversation({
      conversationService,
      loggingService,
      historyService,
      notifier,
    });
    return null;
  };

  const renderer = await renderInAct(<Harness />);
  expect(notifier.approvalNeeded).not.toHaveBeenCalled();

  // Background subagent pauses for approval
  snapshot = { pendingCount: 1, pending: [{ id: 'p1' } as any] };
  act(() => subscriber?.());

  expect(notifier.approvalNeeded).toHaveBeenCalledTimes(1);

  act(() => renderer.unmount());
});
