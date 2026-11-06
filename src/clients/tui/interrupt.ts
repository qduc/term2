import type { RefObject } from 'react';
import type { TuiConnection } from './integration.js';
import type { TuiState } from './state.js';

/**
 * Ctrl+C, in priority order: a pending send confirmation is cleared; a queue edit is discarded; a draft is cleared;
 * a running turn is cancelled (its pending steers are dropped, as legacy); otherwise the exit hint.
 * The plain "Cancellation requested for turn-..." success notice is dropped inside cancelInput; refusals still show.
 */
export function useInterrupt(context: {
  readonly interrupt: RefObject<() => void>;
  /** The foreground approval prompt's Ctrl+C (approval-host.tsx), checked first while it is up. */
  readonly approvalInterrupt: RefObject<(() => boolean) | null> | null;
  readonly connection: TuiConnection;
  readonly cancelQueueEdit: () => boolean;
  readonly confirmation: { readonly pending: boolean; clear(): void };
  readonly state: TuiState;
  /** The text Ctrl+C clears: the open menu's while one owns it, else the composer's. */
  readonly editor: { readonly value: string; replace(text: string): void };
  readonly cancelInput: (connection: TuiConnection, turnId?: string) => Promise<string>;
  readonly setNotice: (text: string | null) => void;
}): void {
  const {
    interrupt,
    approvalInterrupt,
    connection,
    confirmation,
    state,
    editor,
    cancelInput,
    setNotice,
    cancelQueueEdit,
  } = context;
  const notifyError = (error: unknown) => setNotice(error instanceof Error ? error.message : String(error));
  interrupt.current = () => {
    if (approvalInterrupt?.current?.()) return;
    if (confirmation.pending) confirmation.clear();
    else if (cancelQueueEdit()) return;
    // Legacy use-app-keyboard-shortcuts: a draft is cleared first, even mid-turn; only an empty composer stops it.
    else if (editor.value.length > 0) editor.replace('');
    else if (state.activeTurnId || state.interactions.length)
      void cancelInput(connection, state.activeTurnId ?? undefined).then(setNotice, notifyError);
    else setNotice('Press Ctrl+C again to exit');
  };
}
