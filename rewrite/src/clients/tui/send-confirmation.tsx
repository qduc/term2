import React, { useEffect, useRef, useState, type ReactElement } from 'react';
import { Text, type Key } from 'ink';
import ModeSwitchConfirmationPrompt from './presentation/components/prompt/ModeSwitchConfirmationPrompt.js';

/**
 * A send the session said needs confirmation. The draft stays frozen in the
 * composer until a deliberate `y` (send) or `n`/Esc (keep editing). While an
 * approval interaction is open its panel owns the keys, so `y` never lands here.
 */
export function useSendConfirmation(interactionActive: boolean): {
  readonly pending: boolean;
  /** `mode` names the mode a session-clearing switch turns on or off (legacy's mode-switch confirmation). */
  hold(message: string, proceed: () => void, mode?: string, enable?: boolean): void;
  clear(): void;
  /** True when the key was consumed. */
  handleKey(input: string, key: Key): boolean;
  readonly prompt: ReactElement | null;
} {
  const [held, setHeld] = useState<{ message: string; proceed: () => void; mode?: string; enable?: boolean } | null>(
    null,
  );
  const owned = held !== null && !interactionActive;
  // Restart the handoff window whenever this prompt regains the keys from an approval panel.
  const handoffAt = useRef(0);
  useEffect(() => {
    if (!interactionActive) handoffAt.current = performance.now();
  }, [interactionActive]);
  return {
    pending: held !== null,
    hold: (message, proceed, mode, enable) => {
      handoffAt.current = performance.now();
      setHeld({ message, proceed, ...(mode ? { mode, enable } : {}) });
    },
    clear: () => setHeld(null),
    handleKey(input, key) {
      if (!held || !owned) return false;
      // Only a deliberate, lone keypress counts: not the Enter that raised this, a paste, or typeahead.
      if (performance.now() - handoffAt.current < 20) return true;
      // A mode switch is legacy's ModeSwitchConfirmationPrompt, which reads its own keys.
      if (held.mode) return true;
      if (input === 'y' && !key.ctrl && !key.meta) {
        setHeld(null);
        held.proceed();
      } else if (input === 'n' || key.escape) setHeld(null);
      return true;
    },
    prompt:
      held && owned ? (
        held.mode ? (
          <ModeSwitchConfirmationPrompt
            modeLabel={held.mode}
            targetValue={held.enable ?? true}
            onConfirm={() => {
              setHeld(null);
              held.proceed();
            }}
            onDecline={() => setHeld(null)}
          />
        ) : (
          <Text>{held.message} Press y to send, n or Esc to keep editing.</Text>
        )
      ) : null,
  };
}
