// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React from 'react';
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { renderInAct } from '../test-helpers/ink-testing.js';
import { useAppKeyboardShortcuts } from './use-app-keyboard-shortcuts.js';
import type { InputOwner } from '../lib/input-owner.js';

const mocks = vi.hoisted(() => ({
  // Track every registered useInput handler with its options. `isActive` is
  // respected so the test can verify that gated handlers don't fire.
  useInputHandlers: [] as Array<{
    handler: (input: string, key: Record<string, boolean>) => void;
    isActive: boolean;
  }>,
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
  useInput: (handler: (input: string, key: Record<string, boolean>) => void, options?: { isActive?: boolean }) => {
    mocks.useInputHandlers.push({
      handler,
      isActive: options?.isActive !== false,
    });
  },
}));

const fireInput = async (input: string, key: Record<string, boolean>) => {
  await act(async () => {
    for (const { handler, isActive } of mocks.useInputHandlers) {
      if (isActive) handler(input, key);
    }
    await Promise.resolve();
  });
};

const Harness = (props: Parameters<typeof useAppKeyboardShortcuts>[0]) => {
  // Each render registers two `useInput` handlers. Clear at the top so only the
  // latest render's handlers are live (mirrors Ink's per-render semantics and
  // prevents stale handlers from double-firing in `fireInput`).
  mocks.useInputHandlers = [];
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
    inputMode: 'text',
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
    inputOwner: { kind: 'input' } as InputOwner,
    ...overrides,
  };

  return renderInAct(<Harness {...props} />);
};

beforeEach(() => {
  mocks.useInputHandlers = [];
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
  const before = mocks.exitWithUsage.mock.calls.length;

  await fireInput('c', { ctrl: true });

  expect(mocks.exitWithUsage.mock.calls.length).toBe(before + 1);
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
  const before = mocks.stopProcessing.mock.calls.length;

  await fireInput('', { escape: true });

  expect(mocks.stopProcessing.mock.calls.length).toBe(before + 1);
});

it.sequential('does not stop processing on Escape while a slash-command menu is active', async () => {
  await renderHarness({ isProcessing: true, inputMode: 'slash_commands' });

  await fireInput('', { escape: true });

  expect(mocks.stopProcessing).not.toHaveBeenCalled();
});

it.sequential('cancels handoff entry on Escape', async () => {
  await renderHarness({ handoffState: { stage: 'entering_message' } });
  const before = mocks.cancelHandoff.mock.calls.length;

  await fireInput('', { escape: true });

  expect(mocks.cancelHandoff.mock.calls.length).toBe(before + 1);
});

it.sequential('switches app modes with Shift+Tab unless a large uncached turn is pending', async () => {
  await renderHarness();
  const before = mocks.cycleAppModes.mock.calls.length;

  await fireInput('\u001b[Z', { shift: true, tab: true });

  expect(mocks.cycleAppModes.mock.calls.length).toBe(before + 1);
  expect(mocks.toggleShellMode).not.toHaveBeenCalled();
});

it.sequential('toggles shell mode with Shift+Tab in lite mode', async () => {
  await renderHarness({ liteMode: true });
  const before = mocks.toggleShellMode.mock.calls.length;

  await fireInput('\u001b[Z', { shift: true, tab: true });

  expect(mocks.toggleShellMode.mock.calls.length).toBe(before + 1);
  expect(mocks.cycleAppModes).not.toHaveBeenCalled();
});

it.sequential('ignores Shift+Tab while a large uncached turn is pending', async () => {
  await renderHarness({ pendingLargeUncachedTurn: { text: 'large', images: [] } as any });

  await fireInput('\u001b[Z', { shift: true, tab: true });

  expect(mocks.toggleShellMode).not.toHaveBeenCalled();
  expect(mocks.cycleAppModes).not.toHaveBeenCalled();
});

// --- Regression: Esc / shortcuts must stay suppressed while a prompt owns input ---
// Ink fans keypresses out to every mounted useInput hook; the isActive gate on
// the shortcut handler (and the separate always-active Ctrl+C hook) is what
// closes the fan-out coupling. These tests exercise that gate directly.

it.sequential('does NOT stop processing on Escape while approval prompt owns input', async () => {
  await renderHarness({
    isProcessing: false,
    waitingForApproval: true,
    inputOwner: { kind: 'approval' },
  });

  await fireInput('', { escape: true });

  expect(mocks.stopProcessing).not.toHaveBeenCalled();
});

it.sequential('does NOT stop processing on Escape while input-surge prompt owns input', async () => {
  // Surge guards do not clear isProcessing; without the owner gate this would
  // double-fire stopProcessing + onDecline.
  await renderHarness({
    isProcessing: true,
    inputOwner: { kind: 'input-surge' },
  });

  await fireInput('', { escape: true });

  expect(mocks.stopProcessing).not.toHaveBeenCalled();
});

it.sequential('does NOT stop processing on Escape while large-uncached prompt owns input', async () => {
  await renderHarness({
    isProcessing: true,
    pendingLargeUncachedTurn: { text: 'large', images: [] } as any,
    inputOwner: { kind: 'large-uncached' },
  });

  await fireInput('', { escape: true });

  expect(mocks.stopProcessing).not.toHaveBeenCalled();
});

it.sequential('does NOT fire app shortcuts (Shift+Tab) while a prompt owns input', async () => {
  await renderHarness({ inputOwner: { kind: 'handoff-confirm' } });

  await fireInput('\u001b[Z', { shift: true, tab: true });

  expect(mocks.toggleShellMode).not.toHaveBeenCalled();
  expect(mocks.cycleAppModes).not.toHaveBeenCalled();
});

it.sequential('Ctrl+C still exits (global) while a prompt owns input', async () => {
  await renderHarness({ inputOwner: { kind: 'approval' } });
  const before = mocks.exitWithUsage.mock.calls.length;

  await fireInput('c', { ctrl: true });

  expect(mocks.exitWithUsage.mock.calls.length).toBe(before + 1);
});

it.sequential('app shortcuts remain active when owner is input', async () => {
  await renderHarness({ inputOwner: { kind: 'input' } });
  const before = mocks.cycleAppModes.mock.calls.length;

  await fireInput('\u001b[Z', { shift: true, tab: true });

  expect(mocks.cycleAppModes.mock.calls.length).toBe(before + 1);
});
