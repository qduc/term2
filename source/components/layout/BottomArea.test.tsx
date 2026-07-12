// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { InputProvider } from '../../context/InputContext.js';
import BottomArea, { type BottomAreaProps } from './BottomArea.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import type { SlashCommand } from '../../slash-commands.js';

const mockSlashCommands: SlashCommand[] = [{ name: '/clear', description: 'Clear screen', action: () => {} }];

const baseProps: BottomAreaProps = {
  pendingApproval: null,
  waitingForApproval: false,
  waitingForRejectionReason: false,
  isProcessing: false,
  onSubmit: async () => {},
  slashCommands: mockSlashCommands,
  isShellMode: false,
  settingsService: createMockSettingsService(),
  loggingService: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
  } as any,
  historyService: {
    getMessages: () => [],
    addMessage: () => {},
    clear: () => {},
  } as any,
  onApprove: () => {},
  onReject: () => {},
  queuePaused: false,
  queueLength: 0,
  queuePauseReason: undefined,
  onResumeQueue: () => {},
  onDiscardQueue: () => {},
};

const renderBottomArea = async (props: typeof baseProps) => {
  let result: ReturnType<typeof render>;

  await act(async () => {
    result = render(
      <InputProvider>
        <BottomArea {...props} />
      </InputProvider>,
    );

    await Promise.resolve();
  });

  return result!;
};

it.sequential('BottomArea shows input when idle', async () => {
  const { lastFrame, unmount } = await renderBottomArea(baseProps);
  const output = lastFrame() ?? '';
  expect(output.includes('❯')).toBe(true);
  expect(output.includes('processing')).toBe(false);
  expect(output.includes('Allow this action?')).toBe(false);
  act(() => {
    unmount();
  });
});

it.sequential('BottomArea shows approval prompt when waiting for approval', async () => {
  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    pendingApproval: {
      agentName: 'Agent',
      toolName: 'shell',
      argumentsText: '{"commands":"ls"}',
      rawInterruption: null,
    },
    waitingForApproval: true,
  });
  const output = lastFrame() ?? '';
  expect(output.includes('Allow this action?')).toBe(true);
  expect(output.includes('Approve')).toBe(true);
  expect(output.includes('Reject')).toBe(true);
  expect(output.includes('processing')).toBe(false);
  act(() => {
    unmount();
  });
});

it.sequential('BottomArea shows processing indicator when busy', async () => {
  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    isProcessing: true,
  });
  const output = lastFrame() ?? '';
  expect(output.includes('processing.')).toBe(true);
  expect(output.includes('Allow this action?')).toBe(false);
  // With queue mode, input stays visible while processing so the user can queue messages
  expect(output.includes('❯')).toBe(true);
  act(() => {
    unmount();
  });
});

it.sequential('BottomArea shows InputBox while processing when queue mode is active', async () => {
  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    isProcessing: true,
  });
  const output = lastFrame() ?? '';
  // With queue mode, InputBox shows while processing for queuing additional messages
  expect(output.includes('❯')).toBe(true);
  expect(output.includes('processing.')).toBe(true);
  act(() => {
    unmount();
  });
});

it.sequential('BottomArea shows QueuePausedPrompt when queuePaused is true', async () => {
  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    queuePaused: true,
    queueLength: 3,
    queuePauseReason: 'manual',
  });
  const output = lastFrame() ?? '';
  expect(output.includes('Queue paused: 3 item(s) pending.')).toBe(true);
  expect(output.includes('esume')).toBe(true);
  expect(output.includes('iscard')).toBe(true);
  expect(output.includes('❯')).toBe(false);
  act(() => {
    unmount();
  });
});

it.sequential('BottomArea shows QueuePausedPrompt with failure reason', async () => {
  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    queuePaused: true,
    queueLength: 1,
    queuePauseReason: 'failure',
  });
  const output = lastFrame() ?? '';
  expect(output.includes('Queue paused: 1 item(s) pending.')).toBe(true);
  expect(output.includes('Last turn failed.')).toBe(true);
  act(() => {
    unmount();
  });
});

it.sequential('BottomArea shows thinking timer when reasoning is active', async () => {
  const originalNow = Date.now;
  Date.now = () => 12_000;

  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    isProcessing: true,
    thinkingStartedAt: 0,
  });

  const output = lastFrame() ?? '';
  expect(output.includes('Thinking... 12s')).toBe(true);
  expect(output.includes('processing')).toBe(false);

  act(() => {
    unmount();
  });
  Date.now = originalNow;
});

it.sequential('BottomArea shows handoff confirmation prompt when handoffState is confirm_model', async () => {
  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    handoffState: {
      capturedText: 'some test code',
      stage: 'confirm_model',
    },
  });
  const output = lastFrame() ?? '';
  expect(output.includes('📋 Change model?')).toBe(true);
  expect(output.includes('Yes')).toBe(true);
  expect(output.includes('No')).toBe(true);
  expect(output.includes('Allow this action?')).toBe(false);
  act(() => {
    unmount();
  });
});

it.sequential('BottomArea shows large uncached confirmation prompt when pending turn exists', async () => {
  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    pendingLargeUncachedTurn: { text: 'Describe this', images: [] },
    pendingLargeUncachedTokens: 72_100,
    lastUsage: { prompt_tokens: 72_100 },
  });

  const output = lastFrame() ?? '';
  expect(output.includes('Send 72,100 tokens anyway?')).toBe(true);
  expect(output.includes('may miss prompt cache')).toBe(true);
  expect(output.includes('Send')).toBe(true);
  expect(output.includes('Cancel')).toBe(true);
  expect(output.includes('Allow this action?')).toBe(false);
  act(() => {
    unmount();
  });
});

it.sequential('BottomArea shows input with handoff message prompt when handoffState is entering_message', async () => {
  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    handoffState: {
      capturedText: 'some test code',
      stage: 'entering_message',
    },
  });
  const output = lastFrame() ?? '';
  expect(output.includes('Handoff message (enter to use default message):')).toBe(true);
  expect(output.includes('Allow this action?')).toBe(false);
  expect(output.includes('processing')).toBe(false);
  act(() => {
    unmount();
  });
});

it.sequential('BottomArea shows tool call streaming indicator when toolCallStreamingInfo is set', async () => {
  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    isProcessing: true,
    toolCallStreamingInfo: { toolName: 'shell', argumentCharCount: 150 },
  });
  const output = lastFrame() ?? '';
  expect(output.includes('Calling')).toBe(true);
  expect(output.includes('shell')).toBe(true);
  expect(output.includes('150 chars')).toBe(true);
  expect(output.includes('processing')).toBe(false);
  expect(output.includes('Thinking')).toBe(false);
  act(() => {
    unmount();
  });
});

it.sequential('BottomArea shows tool call streaming indicator without tool name', async () => {
  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    isProcessing: true,
    toolCallStreamingInfo: { argumentCharCount: 42 },
  });
  const output = lastFrame() ?? '';
  expect(output.includes('Calling')).toBe(true);
  expect(output.includes('tool')).toBe(true);
  expect(output.includes('42 chars')).toBe(true);
  expect(output.includes('processing')).toBe(false);
  act(() => {
    unmount();
  });
});

it.sequential('BottomArea falls back to processing when toolCallStreamingInfo is null', async () => {
  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    isProcessing: true,
    toolCallStreamingInfo: null,
  });
  const output = lastFrame() ?? '';
  expect(output.includes('processing')).toBe(true);
  expect(output.includes('Calling')).toBe(false);
  act(() => {
    unmount();
  });
});

it.sequential('BottomArea shows tool call streaming over thinking when both are active', async () => {
  const originalNow = Date.now;
  Date.now = () => 5000;

  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    isProcessing: true,
    thinkingStartedAt: 0,
    toolCallStreamingInfo: { toolName: 'shell', argumentCharCount: 100 },
  });
  const output = lastFrame() ?? '';
  // Tool call streaming takes priority over thinking
  expect(output.includes('Calling')).toBe(true);
  expect(output.includes('shell')).toBe(true);
  expect(output.includes('Thinking')).toBe(false);

  act(() => {
    unmount();
  });
  Date.now = originalNow;
});

it.sequential('BottomArea shows input surge confirmation prompt when pending surge turn exists', async () => {
  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    pendingSurgeTurn: { text: 'Some massive text', images: [] },
    pendingSurgeReason: 'Outgoing message count jumped',
  });

  const output = lastFrame() ?? '';
  expect(output.includes('Input Surge Warning: Outgoing message count jumped')).toBe(true);
  expect(output.includes('Send request anyway?')).toBe(true);
  expect(output.includes('Send anyway')).toBe(true);
  expect(output.includes('Cancel')).toBe(true);
  act(() => {
    unmount();
  });
});

it.sequential(
  'BottomArea shows standard mode confirmation prompt when handoffState is confirm_standard_mode',
  async () => {
    const { lastFrame, unmount } = await renderBottomArea({
      ...baseProps,
      handoffState: {
        capturedText: 'some test code',
        stage: 'confirm_standard_mode',
      },
    });
    const output = lastFrame() ?? '';
    expect(output.includes('📋 Switch to standard mode?')).toBe(true);
    expect(output.includes('Yes')).toBe(true);
    expect(output.includes('No')).toBe(true);
    act(() => {
      unmount();
    });
  },
);

it.sequential('BottomArea shows select model prompt when handoffState is selecting_model', async () => {
  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    handoffState: {
      capturedText: 'some test code',
      stage: 'selecting_model',
    },
  });
  const output = lastFrame() ?? '';
  expect(output.includes('Select model for handoff:')).toBe(true);
  act(() => {
    unmount();
  });
});

it.sequential('BottomArea shows select reasoning effort prompt when handoffState is selecting_effort', async () => {
  const { lastFrame, unmount } = await renderBottomArea({
    ...baseProps,
    handoffState: {
      capturedText: 'some test code',
      stage: 'selecting_effort',
    },
  });
  const output = lastFrame() ?? '';
  expect(output.includes('Select reasoning effort level:')).toBe(true);
  act(() => {
    unmount();
  });
});
