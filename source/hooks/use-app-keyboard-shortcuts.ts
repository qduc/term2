import { useRef } from 'react';
import { useInput } from 'ink';
import type { MutableRefObject } from 'react';
import type { SkillInfo } from '../services/skills/skills-service.js';
import type { UserTurn } from '../types/user-turn.js';

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
};

export const useAppKeyboardShortcuts = ({
  exitWithUsage,
  pendingSkillRef,
  waitingForAskUserAnswer,
  setWaitingForAskUserAnswer,
  waitingForRejectionReason,
  setWaitingForRejectionReason,
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
}: UseAppKeyboardShortcutsOptions): void => {
  const stateRef = useRef({
    pendingSkillRef,
    waitingForAskUserAnswer,
    setWaitingForAskUserAnswer,
    waitingForRejectionReason,
    setWaitingForRejectionReason,
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

  useInput((input: string, key) => {
    const current = stateRef.current;

    if (key.ctrl && input === 'c') {
      current.exitWithUsage();
      return;
    }

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

      if (current.isProcessing || current.waitingForApproval) {
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
  });
};
