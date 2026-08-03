import { useRef } from 'react';
import { useInput } from 'ink';
import type { MutableRefObject } from 'react';
import type { InputMode } from '../context/InputContext.js';
import type { SkillInfo } from '../services/skills/skills-service.js';
import type { UserTurn } from '../types/user-turn.js';
import type { InputOwner } from '../lib/input-owner.js';

type HandoffState = {
  stage: string;
} | null;

export type UseAppKeyboardShortcutsOptions = {
  exitWithUsage: () => void;
  pendingSkillRef: MutableRefObject<SkillInfo | null>;
  waitingForAskUserAnswer: boolean;
  setWaitingForAskUserAnswer: (value: boolean) => void;
  waitingForRejectionReason: boolean;
  setWaitingForRejectionReason: (value: boolean) => void;
  inputMode: InputMode;
  isProcessing: boolean;
  waitingForApproval: boolean;
  stopProcessing: () => void;
  handoffState: HandoffState;
  cancelHandoff: () => void;
  pendingLargeUncachedTurn: UserTurn | null;
  liteMode: boolean;
  toggleShellMode: () => void;
  cycleAppModes: () => void;
  replaceInput: (value: string) => void;
  onSkillActivationCancelled: () => void;
  /**
   * Resolved owner of keyboard input. When a non-`'input'` owner is active,
   * a modal confirmation prompt owns input and the shortcut handler stays
   * suppressed — except Ctrl+C, which is handled separately below.
   */
  inputOwner: InputOwner;
};

export const useAppKeyboardShortcuts = ({
  exitWithUsage,
  pendingSkillRef,
  waitingForAskUserAnswer,
  setWaitingForAskUserAnswer,
  waitingForRejectionReason,
  setWaitingForRejectionReason,
  inputMode,
  isProcessing,
  waitingForApproval,
  stopProcessing,
  handoffState,
  cancelHandoff,
  pendingLargeUncachedTurn,
  liteMode,
  toggleShellMode,
  cycleAppModes,
  replaceInput,
  onSkillActivationCancelled,
  inputOwner,
}: UseAppKeyboardShortcutsOptions): void => {
  const stateRef = useRef({
    pendingSkillRef,
    waitingForAskUserAnswer,
    setWaitingForAskUserAnswer,
    waitingForRejectionReason,
    setWaitingForRejectionReason,
    inputMode,
    isProcessing,
    waitingForApproval,
    stopProcessing,
    handoffState,
    cancelHandoff,
    pendingLargeUncachedTurn,
    liteMode,
    toggleShellMode,
    cycleAppModes,
    replaceInput,
    onSkillActivationCancelled,
    exitWithUsage,
  });

  stateRef.current = {
    pendingSkillRef,
    waitingForAskUserAnswer,
    setWaitingForAskUserAnswer,
    waitingForRejectionReason,
    setWaitingForRejectionReason,
    inputMode,
    isProcessing,
    waitingForApproval,
    stopProcessing,
    handoffState,
    cancelHandoff,
    pendingLargeUncachedTurn,
    liteMode,
    toggleShellMode,
    cycleAppModes,
    replaceInput,
    onSkillActivationCancelled,
    exitWithUsage,
  };

  // `inputOwner` is read here via a ref-like pattern: Ink's `isActive` option
  // captures the value at render time, and this hook re-runs on every render,
  // so a fresh `isActive` boolean is passed to `useInput` whenever the owner
  // changes. The `inputOwner` value held by the closure below is therefore also
  // current as of this render.

  // Ctrl+C (emergency exit) remains global: it must work even while a prompt
  // owns input. All other shortcuts are suppressed via `isActive` when a modal
  // prompt is up, so they cannot double-fire against the prompt's own handler.
  useInput(
    (input: string, key) => {
      if (key.ctrl && input === 'c') {
        stateRef.current.exitWithUsage();
      }
    },
    { isActive: true },
  );

  // Non-emergency shortcuts. Suppressed entirely while a modal confirmation
  // prompt owns input (Esc, Shift-Tab, skill/ask-user/rejection-cancel paths).
  // This closes the Ink fan-out coupling: the prompt's own `useInput` is the
  // sole handler for its keys while it is mounted.
  useInput(
    (input: string, key) => {
      const current = stateRef.current;

      if (key.escape) {
        if (current.pendingSkillRef.current) {
          current.pendingSkillRef.current = null;
          current.onSkillActivationCancelled();
          return;
        }

        if (current.waitingForAskUserAnswer) {
          current.setWaitingForAskUserAnswer(false);
          current.replaceInput('');
          return;
        }

        if (current.waitingForRejectionReason) {
          current.setWaitingForRejectionReason(false);
          current.replaceInput('');
          return;
        }

        if (current.inputMode === 'text' && (current.isProcessing || current.waitingForApproval)) {
          current.stopProcessing();
          return;
        }

        if (current.handoffState?.stage === 'entering_message') {
          current.cancelHandoff();
        }

        return;
      }

      const isShiftTab = (key.shift && key.tab) || input === '\u001b[Z';
      if (!isShiftTab) return;

      if (current.pendingLargeUncachedTurn) {
        return;
      }

      if (current.liteMode) {
        current.toggleShellMode();
        return;
      }

      current.cycleAppModes();
    },
    { isActive: inputOwner.kind === 'input' },
  );
};
