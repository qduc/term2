// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { expect, it } from 'vitest';
import React, { act } from 'react';
import { Text } from 'ink';
import { renderInAct } from '../test-helpers/ink-testing.js';
import type { BackgroundTask } from '../services/subagents/subagent-notification-store.js';
import { useConversation } from './use-conversation.js';

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
  const loggingService = {
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as any;

  const Harness = () => {
    const { backgroundSubagentTasks } = useConversation({
      conversationService,
      loggingService,
      historyService: { addMessage() {} },
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
