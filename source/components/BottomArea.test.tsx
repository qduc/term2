import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputProvider } from '../context/InputContext.js';
import BottomArea, { type BottomAreaProps } from './BottomArea.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';
import type { SlashCommand } from '../slash-commands.js';

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
};

const renderBottomArea = (props: typeof baseProps) =>
  render(
    <InputProvider>
      <BottomArea {...props} />
    </InputProvider>,
  );

test('BottomArea shows input when idle', (t) => {
  const { lastFrame, unmount } = renderBottomArea(baseProps);
  const output = lastFrame() ?? '';
  t.true(output.includes('❯'));
  t.false(output.includes('processing'));
  t.false(output.includes('Allow this action?'));
  unmount();
});

test('BottomArea shows approval prompt when waiting for approval', (t) => {
  const { lastFrame, unmount } = renderBottomArea({
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
  t.true(output.includes('Allow this action?'));
  t.true(output.includes('Approve'));
  t.true(output.includes('Reject'));
  t.false(output.includes('processing'));
  unmount();
});

test('BottomArea shows processing indicator when busy', (t) => {
  const { lastFrame, unmount } = renderBottomArea({
    ...baseProps,
    isProcessing: true,
  });
  const output = lastFrame() ?? '';
  t.true(output.includes('processing.'));
  t.false(output.includes('Allow this action?'));
  t.false(output.includes('❯'));
  unmount();
});

test('BottomArea shows handoff confirmation prompt when handoffState is confirm_model', (t) => {
  const { lastFrame, unmount } = renderBottomArea({
    ...baseProps,
    handoffState: {
      capturedText: 'some test code',
      stage: 'confirm_model',
    },
  });
  const output = lastFrame() ?? '';
  t.true(output.includes('📋 Change model?'));
  t.true(output.includes('Yes'));
  t.true(output.includes('No'));
  t.false(output.includes('Allow this action?'));
  unmount();
});

test('BottomArea shows large uncached confirmation prompt when pending turn exists', (t) => {
  const { lastFrame, unmount } = renderBottomArea({
    ...baseProps,
    pendingLargeUncachedTurn: { text: 'Describe this', images: [] },
    pendingLargeUncachedTokens: 72_100,
  });

  const output = lastFrame() ?? '';
  t.true(output.includes('Send ~72k tokens anyway?'));
  t.true(output.includes('Send'));
  t.true(output.includes('Cancel'));
  t.false(output.includes('Allow this action?'));
  unmount();
});

test('BottomArea shows input with handoff message prompt when handoffState is entering_message', (t) => {
  const { lastFrame, unmount } = renderBottomArea({
    ...baseProps,
    handoffState: {
      capturedText: 'some test code',
      stage: 'entering_message',
    },
  });
  const output = lastFrame() ?? '';
  t.true(output.includes('Handoff message:'));
  t.false(output.includes('Allow this action?'));
  t.false(output.includes('processing'));
  unmount();
});
