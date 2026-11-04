import { useRef } from 'react';
import type { Key } from 'ink';
import type { TuiConnection, TuiIntegration } from './integration.js';
import type { useSendConfirmation } from './send-confirmation.js';

/** Shift+Tab arrives as a modified Tab or, on terminals Ink does not decode, as the raw `ESC [ Z` sequence. */
export const isShiftTab = (input: string, key: Key): boolean => (key.shift && key.tab) || input === '\x1b[Z';

/**
 * Toggles the Plan profile through `/plan`; a second press while one is in flight is ignored. When the switch has to
 * clear the conversation first, the user confirms it (y, or n/Esc to cancel) before anything changes.
 */
export function usePlanToggle(
  integration: TuiIntegration,
  connection: TuiConnection,
  confirmation: Pick<ReturnType<typeof useSendConfirmation>, 'hold'>,
  turnActive: boolean,
  setNotice: (text: string | null) => void,
) {
  const pending = useRef(false);
  const run = (command: () => Promise<{ message?: string }>) => {
    if (pending.current) return;
    pending.current = true;
    void command()
      .then(
        (result) => setNotice(result.message ?? 'Mode changed.'),
        (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        pending.current = false;
      });
  };
  return () => {
    const { planNeedsClear, clearAndTogglePlan, planTarget } = integration;
    if (!turnActive && planNeedsClear?.(connection) && clearAndTogglePlan)
      return confirmation.hold(
        'Clear session and switch mode?',
        () => run(() => clearAndTogglePlan(connection)),
        planTarget?.(connection) === 'builtin:plan' ? 'Plan' : 'Bare',
      );
    run(() => integration.command(connection, '/plan'));
  };
}

/** Ctrl+G arrives as a ctrl-modified `g` or, on terminals Ink does not decode, as the raw BEL byte. */
export const isCtrlG = (input: string, key: Key): boolean => (key.ctrl && input === 'g') || input === '\x07';

/** Ctrl+O arrives as a ctrl-modified `o` or, on terminals Ink does not decode, as the raw SI byte. */
export const isCtrlO = (input: string, key: Key): boolean =>
  (key.ctrl && input.toLowerCase() === 'o') || input === '\x0f';

/** Ctrl+T arrives as a ctrl-modified `t` or, on terminals Ink does not decode, as the raw DC4 byte. */
export const isCtrlT = (input: string, key: Key): boolean => (key.ctrl && input === 't') || input === '\x14';
