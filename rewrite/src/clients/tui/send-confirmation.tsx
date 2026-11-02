import React, { useState, type ReactElement } from 'react';
import { Text, type Key } from 'ink';

/**
 * A send the session said needs confirmation. The draft stays frozen in the
 * composer until a deliberate `y` (send) or `n`/Esc (keep editing). While an
 * approval interaction is open its panel owns the keys, so `y` never lands here.
 */
export function useSendConfirmation(interactionActive: boolean): {
  readonly pending: boolean;
  hold(message: string, proceed: () => void): void;
  clear(): void;
  /** True when the key was consumed. */
  handleKey(input: string, key: Key): boolean;
  readonly prompt: ReactElement | null;
} {
  const [held, setHeld] = useState<{ message: string; proceed: () => void; at: number } | null>(null);
  const owned = held !== null && !interactionActive;
  return {
    pending: held !== null,
    hold: (message, proceed) => setHeld({ message, proceed, at: performance.now() }),
    clear: () => setHeld(null),
    handleKey(input, key) {
      if (!held || !owned) return false;
      // Only a deliberate, lone keypress counts: not the Enter that raised this, a paste, or typeahead.
      if (performance.now() - held.at < 20) return true;
      if (input === 'y') {
        setHeld(null);
        held.proceed();
      } else if (input === 'n' || key.escape) setHeld(null);
      return true;
    },
    prompt: held && owned ? <Text>{held.message} Press y to send, n or Esc to keep editing.</Text> : null,
  };
}
