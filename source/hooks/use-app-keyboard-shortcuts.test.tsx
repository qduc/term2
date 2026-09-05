// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React from 'react';
import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { renderInAct } from '../test-helpers/ink-testing.js';
import { mayConsumeRejectionReasonBridge, useAppKeyboardShortcuts } from './use-app-keyboard-shortcuts.js';
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
  cycleAppModes: vi.fn(),
  replaceInput: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
  submitRejectionReason: vi.fn(),
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

const createProps = (
  overrides: Partial<Parameters<typeof useAppKeyboardShortcuts>[0]> = {},
): Parameters<typeof useAppKeyboardShortcuts>[0] => ({
  exitWithUsage: mocks.exitWithUsage,
  pendingSkillRef: mocks.pendingSkillRef as any,
  waitingForAskUserAnswer: false,
  setWaitingForAskUserAnswer: mocks.setWaitingForAskUserAnswer,
  waitingForRejectionReason: false,
  setWaitingForRejectionReason: mocks.setWaitingForRejectionReason,
  inputMode: 'text',
  inputValue: '',
  isProcessing: false,
  waitingForApproval: false,
  stopProcessing: mocks.stopProcessing,
  handoffState: null,
  cancelHandoff: mocks.cancelHandoff,
  pendingLargeUncachedTurn: null,
  cycleAppModes: mocks.cycleAppModes,
  replaceInput: mocks.replaceInput,
  approvalShortcutsEnabled: true,
  onApprove: mocks.onApprove,
  onReject: mocks.onReject,
  submitRejectionReason: mocks.submitRejectionReason,
  onSkillActivationCancelled: mocks.onSkillActivationCancelled,
  inputOwner: { kind: 'input' } as InputOwner,
  ...overrides,
});

const renderHarness = async (overrides: Partial<Parameters<typeof useAppKeyboardShortcuts>[0]> = {}) =>
  renderInAct(<Harness {...createProps(overrides)} />);

beforeEach(() => {
  mocks.useInputHandlers = [];
  mocks.exitWithUsage.mockReset();
  mocks.pendingSkillRef.current = null;
  mocks.setWaitingForAskUserAnswer.mockReset();
  mocks.setWaitingForRejectionReason.mockReset();
  mocks.stopProcessing.mockReset();
  mocks.cancelHandoff.mockReset();
  mocks.cycleAppModes.mockReset();
  mocks.replaceInput.mockReset();
  mocks.onApprove.mockReset();
  mocks.onReject.mockReset();
  mocks.submitRejectionReason.mockReset();
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

it.sequential('does not stop processing on a single Escape', async () => {
  await renderHarness({ isProcessing: true });

  await fireInput('', { escape: true });

  expect(mocks.stopProcessing).not.toHaveBeenCalled();
});

it.sequential('stops processing on a second Escape', async () => {
  await renderHarness({ isProcessing: true });

  await fireInput('', { escape: true });
  await fireInput('', { escape: true });

  expect(mocks.stopProcessing).toHaveBeenCalledTimes(1);
});

it.sequential('stops processing on double Escape while waiting for approval', async () => {
  await renderHarness({ waitingForApproval: true });

  await fireInput('', { escape: true });
  await fireInput('', { escape: true });

  expect(mocks.stopProcessing).toHaveBeenCalledTimes(1);
});

it.sequential('disarms the interrupt confirmation after the timeout window', async () => {
  // `renderInAct` uses a short real-time flush timer during mount. Enable fake
  // timers only after that setup has completed, otherwise the mount itself
  // waits forever for a timer that the test has not advanced yet.
  await renderHarness({ isProcessing: true });
  vi.useFakeTimers();
  try {
    await fireInput('', { escape: true });
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    await fireInput('', { escape: true });

    expect(mocks.stopProcessing).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it.sequential('leaves Escape to the clear-input gesture while the composer has text', async () => {
  await renderHarness({ isProcessing: true, inputValue: 'draft' });

  await fireInput('', { escape: true });
  await fireInput('', { escape: true });

  expect(mocks.stopProcessing).not.toHaveBeenCalled();
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
});

it.sequential('ignores Shift+Tab while a large uncached turn is pending', async () => {
  await renderHarness({ pendingLargeUncachedTurn: { text: 'large', images: [] } as any });

  await fireInput('\u001b[Z', { shift: true, tab: true });

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

  expect(mocks.cycleAppModes).not.toHaveBeenCalled();
});

it.sequential('does NOT fire Escape or Shift+Tab shortcuts while the background task manager owns input', async () => {
  await renderHarness({
    isProcessing: true,
    inputOwner: { kind: 'background-tasks' },
  });

  await fireInput('', { escape: true });
  await fireInput('\u001b[Z', { shift: true, tab: true });

  expect(mocks.stopProcessing).not.toHaveBeenCalled();
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

it.sequential('rejects exactly once and bridges an immediate rejection reason before the editor is ready', async () => {
  // The composition flag is already true when Enter arrives: handleReject
  // flipped it on the `n` keypress, before the reason is submitted.
  await renderHarness({ inputOwner: { kind: 'approval' }, waitingForRejectionReason: true });

  await fireInput('nneeds review', {});
  await fireInput('', { return: true });

  expect(mocks.onReject).toHaveBeenCalledTimes(1);
  expect(mocks.replaceInput).toHaveBeenCalledWith('needs review');
  expect(mocks.submitRejectionReason).toHaveBeenCalledTimes(1);
  expect(mocks.submitRejectionReason).toHaveBeenCalledWith('needs review');
});

it.sequential('drops an orphaned bridged reason so y approves the replacement approval head', async () => {
  // The approval the user pressed n on settled or was replaced while they were
  // typing (head change retires the composition, so the flag is false again).
  // The stale bridge must not swallow y — the replacement approval owns input.
  await renderHarness({ inputOwner: { kind: 'approval' }, waitingForApproval: true });

  await fireInput('nunsafe change', {});
  await fireInput('y', {});

  expect(mocks.onApprove).toHaveBeenCalledTimes(1);
  expect(mocks.onReject).toHaveBeenCalledTimes(1);
  expect(mocks.submitRejectionReason).not.toHaveBeenCalled();
});

it.sequential('does not submit an orphaned bridged reason to a replacement approval head on Enter', async () => {
  await renderHarness({ inputOwner: { kind: 'approval' }, waitingForApproval: true });

  await fireInput('nunsafe change', {});
  await fireInput('', { return: true });

  expect(mocks.submitRejectionReason).not.toHaveBeenCalled();
  expect(mocks.onApprove).not.toHaveBeenCalled();
  // The stale reason is dropped from the composer rather than left to leak
  // into a later turn or another composition.
  expect(mocks.replaceInput).toHaveBeenLastCalledWith('');
});

it.sequential('does not let the rejection-reason bridge consume manager keys', async () => {
  expect(mayConsumeRejectionReasonBridge({ kind: 'approval' })).toBe(true);
  expect(mayConsumeRejectionReasonBridge({ kind: 'input' })).toBe(true);
  expect(mayConsumeRejectionReasonBridge({ kind: 'background-tasks' })).toBe(false);
  expect(mayConsumeRejectionReasonBridge({ kind: 'menu' })).toBe(false);
});

it.sequential('approves exactly once at the stable approval boundary', async () => {
  await renderHarness({ inputOwner: { kind: 'approval' } });

  await fireInput('y', {});

  expect(mocks.onApprove).toHaveBeenCalledTimes(1);
  expect(mocks.onReject).not.toHaveBeenCalled();
});

it.sequential('opens model menu on Ctrl+O when input owner is input', async () => {
  await renderHarness({ inputOwner: { kind: 'input' } });

  await fireInput('o', { ctrl: true });

  expect(mocks.replaceInput).toHaveBeenCalledTimes(1);
  expect(mocks.replaceInput).toHaveBeenCalledWith('/model ');
});

it.sequential('opens model menu on raw byte \x0f (Ctrl+O) when input owner is input', async () => {
  await renderHarness({ inputOwner: { kind: 'input' } });

  await fireInput('\x0f', {});

  expect(mocks.replaceInput).toHaveBeenCalledTimes(1);
  expect(mocks.replaceInput).toHaveBeenCalledWith('/model ');
});

it.sequential('opens effort menu on Ctrl+T when input owner is input', async () => {
  await renderHarness({ inputOwner: { kind: 'input' } });

  await fireInput('t', { ctrl: true });

  expect(mocks.replaceInput).toHaveBeenCalledTimes(1);
  expect(mocks.replaceInput).toHaveBeenCalledWith('/effort ');
});

it.sequential('opens effort menu on raw byte \x14 (Ctrl+T) when input owner is input', async () => {
  await renderHarness({ inputOwner: { kind: 'input' } });

  await fireInput('\x14', {});

  expect(mocks.replaceInput).toHaveBeenCalledTimes(1);
  expect(mocks.replaceInput).toHaveBeenCalledWith('/effort ');
});

it.sequential('does not trigger Ctrl+O or Ctrl+T when input owner is not input', async () => {
  await renderHarness({ inputOwner: { kind: 'approval' } });

  await fireInput('o', { ctrl: true });
  await fireInput('t', { ctrl: true });

  expect(mocks.replaceInput).not.toHaveBeenCalled();
});
