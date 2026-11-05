import { useEffect, useRef, useState } from 'react';

/**
 * How long the "press Escape again to interrupt" confirmation stays armed.
 * Matches the double-Escape window used to clear the input buffer
 * (`use-escape-key.ts`) so both gestures feel the same.
 */
const INTERRUPT_CONFIRM_TIMEOUT_MS = 2000;

/**
 * Copied from legacy source/hooks/use-app-keyboard-shortcuts.ts: Escape on an empty composer during a turn arms
 * an interrupt, and a second Escape inside the window stops the turn. `press` returns true when it took the key.
 */
export function useInterruptConfirm(turnInFlight: boolean, inputValue: string, stop: () => void) {
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

  // Disarm as soon as the turn ends — or as soon as the user types, since
  // Escape then means "clear the buffer" — so an armed confirmation can never
  // be completed by a later, unrelated Escape.
  useEffect(() => {
    if (!turnInFlight || inputValue.length > 0) disarmInterrupt();
  }, [turnInFlight, inputValue]);

  useEffect(
    () => () => {
      if (interruptTimeoutRef.current) clearTimeout(interruptTimeoutRef.current);
    },
    [],
  );

  const press = (): boolean => {
    // A non-empty composer means Escape belongs to the clear-buffer
    // gesture in `use-escape-key.ts`; interrupting only claims Escape once
    // there is nothing left to clear.
    if (!turnInFlight || inputValue.length !== 0) return false;
    // Interrupting a turn throws away real work, and Escape is easy to hit
    // by accident (stray key, leftover terminal escape sequence). Require a
    // second Escape inside a short window to confirm.
    if (armedRef.current) {
      disarmInterrupt();
      stop();
      return true;
    }
    armedRef.current = true;
    setInterruptConfirmVisible(true);
    if (interruptTimeoutRef.current) clearTimeout(interruptTimeoutRef.current);
    interruptTimeoutRef.current = setTimeout(() => {
      interruptTimeoutRef.current = null;
      disarmInterrupt();
    }, INTERRUPT_CONFIRM_TIMEOUT_MS);
    return true;
  };

  return { interruptConfirmVisible, press };
}
