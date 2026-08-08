import { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import type { MutableRefObject } from 'react';
import type { InputMode } from '../context/InputContext.js';
import type { SkillInfo } from '../services/skills/skills-service.js';
import type { UserTurn } from '../types/user-turn.js';
import type { InputOwner } from '../lib/input-owner.js';

type HandoffState = {
  stage: string;
} | null;

/**
 * How long the "press Escape again to interrupt" confirmation stays armed.
 * Matches the double-Escape window used to clear the input buffer
 * (`use-escape-key.ts`) so both gestures feel the same.
 */
const INTERRUPT_CONFIRM_TIMEOUT_MS = 2000;

export type UseAppKeyboardShortcutsResult = {
  /** True while a second Escape would interrupt the in-flight turn. */
  interruptConfirmVisible: boolean;
};

export type UseAppKeyboardShortcutsOptions = {
  exitWithUsage: () => void;
  pendingSkillRef: MutableRefObject<SkillInfo | null>;
  waitingForAskUserAnswer: boolean;
  setWaitingForAskUserAnswer: (value: boolean) => void;
  waitingForRejectionReason: boolean;
  setWaitingForRejectionReason: (value: boolean) => void;
  inputMode: InputMode;
  /**
   * Current composer text. Escape clears a non-empty buffer (handled by
   * `use-escape-key.ts`), so the interrupt confirmation only claims Escape when
   * this is empty. The emptiness predicate must match that hook's exactly.
   */
  inputValue: string;
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
  inputValue,
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
}: UseAppKeyboardShortcutsOptions): UseAppKeyboardShortcutsResult => {
  // `armedRef` — not the state below — is what the key handler reads. A user can
  // press Escape twice faster than React commits a render, so the confirmation
  // must not depend on the re-render landing between the two presses. The state
  // exists only to show the hint.
  const armedRef = useRef(false);
  const [interruptConfirmVisible, setInterruptConfirmVisible] = useState(false);
  const interruptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarmInterrupt = (): void => {
    armedRef.current = false;
    if (interruptTimeoutRef.current) {
      clearTimeout(interruptTimeoutRef.current);
      interruptTimeoutRef.current = null;
    }
    setInterruptConfirmVisible(false);
  };

  const stateRef = useRef({
    pendingSkillRef,
    waitingForAskUserAnswer,
    setWaitingForAskUserAnswer,
    waitingForRejectionReason,
    setWaitingForRejectionReason,
    inputMode,
    inputValue,
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
    inputValue,
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

        if (
          current.inputMode === 'text' &&
          (current.isProcessing || current.waitingForApproval) &&
          // A non-empty composer means Escape belongs to the clear-buffer
          // gesture in `use-escape-key.ts`; interrupting only claims Escape once
          // there is nothing left to clear.
          current.inputValue.length === 0
        ) {
          // Interrupting a turn throws away real work, and Escape is easy to hit
          // by accident (stray key, leftover terminal escape sequence). Require a
          // second Escape inside a short window to confirm.
          if (armedRef.current) {
            disarmInterrupt();
            current.stopProcessing();
            return;
          }

          armedRef.current = true;
          setInterruptConfirmVisible(true);
          if (interruptTimeoutRef.current) clearTimeout(interruptTimeoutRef.current);
          interruptTimeoutRef.current = setTimeout(() => {
            interruptTimeoutRef.current = null;
            disarmInterrupt();
          }, INTERRUPT_CONFIRM_TIMEOUT_MS);
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

  // Disarm as soon as the turn ends — or as soon as the user types, since
  // Escape then means "clear the buffer" — so an armed confirmation can never
  // be completed by a later, unrelated Escape.
  useEffect(() => {
    if ((!isProcessing && !waitingForApproval) || inputValue.length > 0) {
      disarmInterrupt();
    }
  }, [isProcessing, waitingForApproval, inputValue]);

  useEffect(
    () => () => {
      if (interruptTimeoutRef.current) clearTimeout(interruptTimeoutRef.current);
    },
    [],
  );

  return { interruptConfirmVisible };
};
