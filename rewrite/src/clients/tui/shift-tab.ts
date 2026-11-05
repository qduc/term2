import { useRef } from 'react';
import type { Key } from 'ink';
import type { TuiConnection, TuiIntegration } from './integration.js';
import type { useSendConfirmation } from './send-confirmation.js';
import { WELCOME } from './replace-session.js';

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
  beginNewConversation?: (lines: readonly string[] | null) => void,
) {
  const pending = useRef(false);
  const run = (command: () => Promise<{ message?: string }>) => {
    if (pending.current) return;
    pending.current = true;
    void command()
      .then(
        (result) => setNotice(result.message ?? null),
        (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        pending.current = false;
      });
  };
  /** Legacy handleModeSwitchConfirm: on Yes, a new conversation, its welcome, then the mode line. */
  const confirmSwitch = (label: string, enable: boolean, line: string, clear: () => Promise<{ message?: string }>) =>
    confirmation.hold(
      'Clear session and switch mode?',
      () => {
        beginNewConversation?.([WELCOME, line]);
        run(() =>
          clear().then(
            () => ({}),
            (error: unknown) => {
              beginNewConversation?.(null);
              throw error;
            },
          ),
        );
      },
      label,
      enable,
    );
  const toggle = () => {
    const { planNeedsClear, clearAndTogglePlan, planTarget } = integration;
    const confirmPlan = () => {
      const label = planTarget?.(connection) === 'builtin:plan' ? 'Plan' : 'Bare';
      confirmSwitch(label, true, `${label} mode enabled`, () => clearAndTogglePlan!(connection));
    };
    if (!turnActive && planNeedsClear?.(connection) && clearAndTogglePlan) return confirmPlan();
    // Legacy cycleAppModes asks the same during a turn, when the switch is to or from Bare with history.
    run(() =>
      integration.command(connection, '/plan').then((result) => {
        if (result.confirmClear && clearAndTogglePlan) confirmPlan();
        return result;
      }),
    );
  };
  return {
    toggle,
    /** A command's `confirmClear` (legacy /profile to or from Bare with history). */
    confirmClear(request: { readonly profileId: string; readonly enable: boolean; readonly line: string }) {
      const { clearAndSwitch } = integration;
      if (clearAndSwitch)
        confirmSwitch('Bare', request.enable, request.line, () => clearAndSwitch(connection, request.profileId));
    },
  };
}

/** Ctrl+G arrives as a ctrl-modified `g` or, on terminals Ink does not decode, as the raw BEL byte. */
export const isCtrlG = (input: string, key: Key): boolean => (key.ctrl && input === 'g') || input === '\x07';

/** Ctrl+O arrives as a ctrl-modified `o` or, on terminals Ink does not decode, as the raw SI byte. */
export const isCtrlO = (input: string, key: Key): boolean =>
  (key.ctrl && input.toLowerCase() === 'o') || input === '\x0f';

/** Ctrl+T arrives as a ctrl-modified `t` or, on terminals Ink does not decode, as the raw DC4 byte. */
export const isCtrlT = (input: string, key: Key): boolean => (key.ctrl && input === 't') || input === '\x14';
