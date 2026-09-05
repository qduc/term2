// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { Text } from 'ink';
import { renderInAct } from '../test-helpers/ink-testing.js';
import type { BackgroundTask } from '../services/subagents/subagent-notification-store.js';
import { BackgroundSubagentApprovalQueue } from '../services/approval/background-subagent-approval-queue.js';
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
  let nestedObserver: ((snapshot: any) => void) | null = null;
  const queue = new BackgroundSubagentApprovalQueue();
  const backgroundEntry = {
    runId: 'background-1',
    generation: 1,
    toolCallId: 'b1',
    toolName: 'create_file',
    argumentsText: '{}',
  };
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
    backgroundSubagentApprovals: queue,
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

  act(() => queue.enqueue(backgroundEntry, { onResolve: () => ({ kind: 'applied' }) }));

  expect(renderer.lastFrame()).toBe('reason');
  expect(current.nested).toEqual(nestedSnapshot);
  expect(nestedObserver).toBeTruthy();
  act(() => renderer.unmount());
});

it.sequential('retires a background rejection composer when its real queue settles', async () => {
  const queue = new BackgroundSubagentApprovalQueue();
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
  const nestedDecisions: any[] = [];
  let nestedObserver: ((snapshot: any) => void) | null = null;
  const conversationService = {
    sessionId: 'real-background-rejection-owner',
    backgroundSubagentTasks: { getSnapshot: () => [] },
    setBackgroundSubagentTaskObserver: () => {},
    backgroundTaskControl: { listDetails: () => [], listForegroundTransferCandidates: () => [] },
    backgroundSubagentApprovals: queue,
    getNestedApprovalSnapshot: () => nestedSnapshot,
    setNestedApprovalObserver: (observer: ((snapshot: any) => void) | null) => {
      nestedObserver = observer;
    },
    setPendingInteractionObserver: () => {},
    setRetryCallback: () => {},
    decideNestedApproval: async (requestId: string, decision: any) => {
      nestedDecisions.push({ requestId, decision });
      return { kind: 'resolved' };
    },
  } as any;
  let state: any;
  const Harness = () => {
    state = useConversation({ conversationService, loggingService, historyService });
    const displayed = state.backgroundSubagentApproval.current;
    return (
      <Text>
        {`${state.waitingForRejectionReason ? 'waiting' : 'idle'}|${displayed?.toolName ?? '-'}|${
          displayed?.argumentsText ?? '-'
        }|${state.nestedApproval?.requestId ?? '-'}`}
      </Text>
    );
  };

  const renderer = await renderInAct(<Harness />);
  const backgroundEntry = {
    runId: 'background-1',
    generation: 1,
    toolCallId: 'background-call-1',
    toolName: 'create_file',
    argumentsText: '{"path":"/outside/background.txt"}',
  };
  const committed: any[] = [];
  let actualEffects = 0;

  act(() => state.setWaitingForRejectionReason(true));
  expect(state.waitingForRejectionReason).toBe(true);

  act(() => {
    queue.enqueue(backgroundEntry, {
      onResolve: (entry, decision) => {
        committed.push({ entry, decision });
        actualEffects += 1;
        return { kind: 'applied' };
      },
    });
    queue.enqueue(
      {
        runId: 'background-2',
        generation: 1,
        toolCallId: 'background-call-2',
        toolName: 'delete_file',
        argumentsText: '{"path":"/outside/next.txt"}',
      },
      { onResolve: () => ({ kind: 'applied' }) },
    );
  });
  expect(renderer.lastFrame()).toBe('waiting|create_file|{"path":"/outside/background.txt"}|nested-1');

  const snapshot = queue.getSnapshot();
  act(() => {
    queue.resolve({
      revision: snapshot.revision,
      entry: backgroundEntry,
      decision: { answer: 'no', rejectionReason: 'background reason' },
    });
  });

  expect(state.waitingForRejectionReason).toBe(false);
  expect(renderer.lastFrame()).toBe('idle|delete_file|{"path":"/outside/next.txt"}|nested-1');
  act(() => state.setWaitingForRejectionReason(false));
  expect(state.waitingForRejectionReason).toBe(false);
  expect(committed).toHaveLength(1);
  expect(committed[0]).toEqual({
    entry: backgroundEntry,
    decision: { answer: 'no', rejectionReason: 'background reason' },
  });
  expect(actualEffects).toBe(1);

  let ordinaryWasRouted = true;
  await act(async () => {
    ordinaryWasRouted = await state.submitConversationTurn({ text: 'ordinary message' });
  });
  expect(ordinaryWasRouted).toBe(false);
  expect(nestedDecisions).toHaveLength(0);

  await act(async () => {
    await state.resolveNestedApproval({ answer: 'y' });
  });
  expect(nestedDecisions).toEqual([{ requestId: 'nested-1', decision: { answer: 'y' } }]);
  act(() => renderer.unmount());
  expect(nestedObserver).toBeNull();
});

it.sequential('clears the composer when its background approval is removed or the queue closes', async () => {
  const runCase = async (close: boolean) => {
    const queue = new BackgroundSubagentApprovalQueue();
    const entry = {
      runId: close ? 'close-run' : 'remove-run',
      generation: 1,
      toolCallId: 'call',
      toolName: 'create_file',
      argumentsText: '{}',
    };
    const conversationService = {
      sessionId: close ? 'close-background-rejection' : 'remove-background-rejection',
      backgroundSubagentTasks: { getSnapshot: () => [] },
      setBackgroundSubagentTaskObserver: () => {},
      backgroundTaskControl: { listDetails: () => [], listForegroundTransferCandidates: () => [] },
      backgroundSubagentApprovals: queue,
      setPendingInteractionObserver: () => {},
      setNestedApprovalObserver: () => {},
      setRetryCallback: () => {},
    } as any;
    let state: any;
    const Harness = () => {
      state = useConversation({ conversationService, loggingService, historyService });
      return <Text>{state.waitingForRejectionReason ? 'reason' : 'idle'}</Text>;
    };
    const renderer = await renderInAct(<Harness />);
    act(() => queue.enqueue(entry, { onResolve: () => ({ kind: 'applied' }) }));
    act(() => state.setWaitingForRejectionReason(true));
    expect(renderer.lastFrame()).toBe('reason');
    act(() => {
      if (close) queue.close();
      else queue.remove({ revision: queue.getSnapshot().revision, entry });
    });
    expect(renderer.lastFrame()).toBe('idle');
    expect(state.waitingForRejectionReason).toBe(false);
    act(() => renderer.unmount());
  };
  await runCase(false);
  await runCase(true);
});
it.sequential('Escape retires a background rejection composer through its production close transition', async () => {
  const queue = new BackgroundSubagentApprovalQueue();
  const entry = {
    runId: 'escape-run',
    generation: 1,
    toolCallId: 'escape-call',
    toolName: 'create_file',
    argumentsText: '{}',
  };
  const conversationService = {
    sessionId: 'escape-background-rejection',
    backgroundSubagentTasks: { getSnapshot: () => [] },
    setBackgroundSubagentTaskObserver: () => {},
    backgroundTaskControl: { listDetails: () => [], listForegroundTransferCandidates: () => [] },
    backgroundSubagentApprovals: queue,
    setPendingInteractionObserver: () => {},
    setNestedApprovalObserver: () => {},
    setRetryCallback: () => {},
  } as any;
  let state: any;
  const Harness = () => {
    state = useConversation({ conversationService, loggingService, historyService });
    return <Text>{state.waitingForRejectionReason ? 'reason' : 'idle'}</Text>;
  };
  const renderer = await renderInAct(<Harness />);
  act(() => queue.enqueue(entry, { onResolve: () => ({ kind: 'applied' }) }));
  act(() => state.setWaitingForRejectionReason(true));
  expect(renderer.lastFrame()).toBe('reason');
  // Escape invokes this same production setter in use-app-keyboard-shortcuts.
  act(() => state.setWaitingForRejectionReason(false));
  expect(renderer.lastFrame()).toBe('idle');
  expect(state.waitingForRejectionReason).toBe(false);
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
