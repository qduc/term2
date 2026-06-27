// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React from 'react';
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { renderInAct } from '../test-helpers/ink-testing.js';
import { useAppKeyboardShortcuts } from './use-app-keyboard-shortcuts.js';

const mocks = vi.hoisted(() => ({
  useInputHandler: null as ((input: string, key: Record<string, boolean>) => void) | null,
  exitWithUsage: vi.fn(),
  pendingSkillRef: { current: null as { name: string } | null },
  setWaitingForAskUserAnswer: vi.fn(),
  setWaitingForRejectionReason: vi.fn(),
  stopProcessing: vi.fn(),
  cancelHandoff: vi.fn(),
  toggleShellMode: vi.fn(),
  cycleAppModes: vi.fn(),
  replaceInput: vi.fn(),
  onSkillActivationCancelled: vi.fn(),
}));

vi.mock('ink', () => ({
  Text: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useInput: (handler: (input: string, key: Record<string, boolean>) => void) => {
    mocks.useInputHandler = handler;
  },
}));

const fireInput = async (input: string, key: Record<string, boolean>) => {
  await act(async () => {
    mocks.useInputHandler?.(input, key);
    await Promise.resolve();
  });
};

const Harness = (props: Parameters<typeof useAppKeyboardShortcuts>[0]) => {
  useAppKeyboardShortcuts(props);
  return <Text>ready</Text>;
};

const renderHarness = async (overrides: Partial<Parameters<typeof useAppKeyboardShortcuts>[0]> = {}) => {
  const props: Parameters<typeof useAppKeyboardShortcuts>[0] = {
    exitWithUsage: mocks.exitWithUsage,
    pendingSkillRef: mocks.pendingSkillRef as any,
    waitingForAskUserAnswer: false,
    setWaitingForAskUserAnswer: mocks.setWaitingForAskUserAnswer,
    waitingForRejectionReason: false,
    setWaitingForRejectionReason: mocks.setWaitingForRejectionReason,
    isProcessing: false,
    waitingForApproval: false,
    stopProcessing: mocks.stopProcessing,
    handoffState: null,
    cancelHandoff: mocks.cancelHandoff,
    pendingLargeUncachedTurn: null,
    liteMode: false,
    toggleShellMode: mocks.toggleShellMode,
    cycleAppModes: mocks.cycleAppModes,
    replaceInput: mocks.replaceInput,
    onSkillActivationCancelled: mocks.onSkillActivationCancelled,
    ...overrides,
  };

  return renderInAct(<Harness {...props} />);
};

beforeEach(() => {
  mocks.useInputHandler = null;
  mocks.exitWithUsage.mockReset();
  mocks.pendingSkillRef.current = null;
  mocks.setWaitingForAskUserAnswer.mockReset();
  mocks.setWaitingForRejectionReason.mockReset();
  mocks.stopProcessing.mockReset();
  mocks.cancelHandoff.mockReset();
  mocks.toggleShellMode.mockReset();
  mocks.cycleAppModes.mockReset();
  mocks.replaceInput.mockReset();
  mocks.onSkillActivationCancelled.mockReset();
});

it.sequential('exits immediately on Ctrl+C', async () => {
  await renderHarness();

  await fireInput('c', { ctrl: true });

  expect(mocks.exitWithUsage).toHaveBeenCalledTimes(1);
});

it.sequential('cancels pending skill activation on Escape', async () => {
  mocks.pendingSkillRef.current = { name: 'Refactor' };

  await renderHarness();

  await fireInput('', { escape: true });

  expect(mocks.pendingSkillRef.current).toBeNull();
  expect(mocks.onSkillActivationCancelled).toHaveBeenCalledTimes(1);
});

it.sequential('clears ask-user answers on Escape', async () => {
  await renderHarness({ waitingForAskUserAnswer: true });

  await fireInput('', { escape: true });

  expect(mocks.setWaitingForAskUserAnswer).toHaveBeenCalledWith(false);
  expect(mocks.replaceInput).toHaveBeenCalledWith('');
});

it.sequential('stops processing on Escape when waiting for approval', async () => {
  await renderHarness({ isProcessing: true });

  await fireInput('', { escape: true });

  expect(mocks.stopProcessing).toHaveBeenCalledTimes(1);
});

it.sequential('cancels handoff entry on Escape', async () => {
  await renderHarness({ handoffState: { stage: 'entering_message' } });

  await fireInput('', { escape: true });

  expect(mocks.cancelHandoff).toHaveBeenCalledTimes(1);
});

it.sequential('switches app modes with Shift+Tab unless a large uncached turn is pending', async () => {
  await renderHarness();

  await fireInput('\u001b[Z', { shift: true, tab: true });

  expect(mocks.cycleAppModes).toHaveBeenCalledTimes(1);
  expect(mocks.toggleShellMode).not.toHaveBeenCalled();
});

it.sequential('toggles shell mode with Shift+Tab in lite mode', async () => {
  await renderHarness({ liteMode: true });

  await fireInput('\u001b[Z', { shift: true, tab: true });

  expect(mocks.toggleShellMode).toHaveBeenCalledTimes(1);
  expect(mocks.cycleAppModes).not.toHaveBeenCalled();
});

it.sequential('ignores Shift+Tab while a large uncached turn is pending', async () => {
  await renderHarness({ pendingLargeUncachedTurn: { text: 'large', images: [] } as any });

  await fireInput('\u001b[Z', { shift: true, tab: true });

  expect(mocks.toggleShellMode).not.toHaveBeenCalled();
  expect(mocks.cycleAppModes).not.toHaveBeenCalled();
});
