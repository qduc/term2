import React, { useEffect, useRef, useState, type ReactElement } from 'react';
import { Text, type Key } from 'ink';
import ModeSwitchConfirmationPrompt from './presentation/components/prompt/ModeSwitchConfirmationPrompt.js';
import InputSurgeConfirmationPrompt from './presentation/components/prompt/InputSurgeConfirmationPrompt.js';
import LargeUncachedConfirmationPrompt from './presentation/components/prompt/LargeUncachedConfirmationPrompt.js';
import type { SendHold } from './commands.js';

type Held = {
  message: string;
  proceed: () => void;
  mode?: string;
  enable?: boolean;
  surge?: string;
  large?: { tokens: number; usage?: { prompt_tokens: number; cache_read_tokens: number } };
};

/**
 * A send the session said needs confirmation. The draft stays frozen in the
 * composer until a deliberate `y` (send) or `n`/Esc (keep editing). While an
 * approval interaction is open its panel owns the keys, so `y` never lands here.
 */
export function useSendConfirmation(interactionActive: boolean): {
  readonly pending: boolean;
  /** `mode` names the mode a session-clearing switch turns on or off (legacy's mode-switch confirmation). */
  hold(message: string, proceed: () => void, mode?: string, enable?: boolean): void;
  /** A held send: legacy's input-surge or large-uncached prompt, which read their own keys. */
  holdSend(
    hold: SendHold,
    proceed: () => void,
    lastUsage?: { readonly inputTokens: number; readonly cachedInputTokens: number },
  ): void;
  /** Legacy StatusBar's `confirm cache miss ~Nk`: the held large send's estimate. */
  readonly largeTokens: number | undefined;
  readonly surgePending: boolean;
  clear(): void;
  /** True when the key was consumed. */
  handleKey(input: string, key: Key): boolean;
  readonly prompt: ReactElement | null;
} {
  const [held, setHeld] = useState<Held | null>(null);
  const owned = held !== null && !interactionActive;
  const confirm = (current: Held) => () => {
    setHeld(null);
    current.proceed();
  };
  const decline = () => setHeld(null);
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
    holdSend: (hold, proceed, lastUsage) => {
      handoffAt.current = performance.now();
      setHeld({
        message: hold.message,
        proceed,
        ...(hold.surge !== undefined ? { surge: hold.surge } : {}),
        ...(hold.largeTokens !== undefined
          ? {
              large: {
                tokens: hold.largeTokens,
                ...(lastUsage
                  ? { usage: { prompt_tokens: lastUsage.inputTokens, cache_read_tokens: lastUsage.cachedInputTokens } }
                  : {}),
              },
            }
          : {}),
      });
    },
    largeTokens: held?.large?.tokens,
    surgePending: held?.surge !== undefined,
    clear: () => setHeld(null),
    handleKey(input, key) {
      if (!held || !owned) return false;
      // Only a deliberate, lone keypress counts: not the Enter that raised this, a paste, or typeahead.
      if (performance.now() - handoffAt.current < 20) return true;
      // Legacy's mode-switch, input-surge and large-uncached prompts read their own keys.
      if (held.mode || held.surge !== undefined || held.large) return true;
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
        ) : held.surge !== undefined ? (
          <InputSurgeConfirmationPrompt reason={held.surge} onConfirm={confirm(held)} onDecline={decline} />
        ) : held.large ? (
          <LargeUncachedConfirmationPrompt usage={held.large.usage} onConfirm={confirm(held)} onDecline={decline} />
        ) : (
          <Text>{held.message} Press y to send, n or Esc to keep editing.</Text>
        )
      ) : null,
  };
}
