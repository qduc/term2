import React, { useEffect, useRef, useState, type ReactElement } from 'react';
import { Text, type Key } from 'ink';
import { useTheme } from './presentation/components/theme.js';
import { useSkin } from './presentation/skins/SkinContext.js';

/**
 * A send the session said needs confirmation. The draft stays frozen in the
 * composer until a deliberate `y` (send) or `n`/Esc (keep editing). While an
 * approval interaction is open its panel owns the keys, so `y` never lands here.
 */
export function useSendConfirmation(interactionActive: boolean): {
  readonly pending: boolean;
  hold(message: string, proceed: () => void, hint?: string): void;
  clear(): void;
  /** True when the key was consumed. */
  handleKey(input: string, key: Key): boolean;
  readonly prompt: ReactElement | null;
} {
  const theme = useTheme();
  const { MenuFrame } = useSkin();
  const [selected, setSelected] = useState<0 | 1>(1);
  const [held, setHeld] = useState<{ message: string; proceed: () => void; hint?: string } | null>(null);
  const owned = held !== null && !interactionActive;
  // Restart the handoff window whenever this prompt regains the keys from an approval panel.
  const handoffAt = useRef(0);
  useEffect(() => {
    if (!interactionActive) handoffAt.current = performance.now();
  }, [interactionActive]);
  return {
    pending: held !== null,
    hold: (message, proceed, hint) => {
      handoffAt.current = performance.now();
      setSelected(1);
      setHeld({ message, proceed, hint });
    },
    clear: () => setHeld(null),
    handleKey(input, key) {
      if (!held || !owned) return false;
      // Only a deliberate, lone keypress counts: not the Enter that raised this, a paste, or typeahead.
      if (performance.now() - handoffAt.current < 20) return true;
      if (held.hint && (key.upArrow || key.downArrow)) {
        setSelected(selected === 0 ? 1 : 0);
        return true;
      }
      if ((input === 'y' && !key.ctrl && !key.meta) || (held.hint && key.return && selected === 0)) {
        setHeld(null);
        held.proceed();
      } else if (input === 'n' || key.escape || (held.hint && key.return && selected === 1)) setHeld(null);
      return true;
    },
    prompt:
      held && owned ? (
        held.hint ? (
          <MenuFrame borderColor={theme.borderActive} hasItems={false} footerPlacement="outside">
            <Text color={theme.warning}>⚠ Switching modes requires clearing the current session.</Text>
            <Text bold>{held.message}</Text>
            <Text color={selected === 0 ? theme.accent : theme.textMuted}>{selected === 0 ? '›' : ' '} Yes</Text>
            <Text color={selected === 1 ? theme.accent : theme.textMuted}>{selected === 1 ? '›' : ' '} No</Text>
            <Text color={theme.textSubtle}>↑/↓ select · Enter choose · y/n answer · Esc cancel</Text>
          </MenuFrame>
        ) : (
          <Text>{held.message} Press y to send, n or Esc to keep editing.</Text>
        )
      ) : null,
  };
}
