import type { RefObject } from 'react';
import type { TuiConnection } from './integration.js';
import type { TuiState } from './state.js';

/**
 * Ctrl+C, in priority order: a pending send confirmation is cleared; a queue edit is discarded; a running turn is cancelled (its queued steers
 * come back as a draft) and the draft kept; with nothing running the draft is cleared; otherwise the exit hint.
 * The plain "Cancellation requested for turn-..." success notice is dropped inside cancelInput; returned-steer and
 * refusal messages still show.
 */
export function useInterrupt(context: {
  readonly interrupt: RefObject<() => void>;
  /** The foreground approval prompt's Ctrl+C (approval-host.tsx), checked first while it is up. */
  readonly approvalInterrupt: RefObject<(() => boolean) | null> | null;
  readonly connection: TuiConnection;
  readonly cancelQueueEdit: () => boolean;
  readonly confirmation: { readonly pending: boolean; clear(): void };
  readonly state: TuiState;
  readonly editor: { readonly value: string };
  readonly replaceInput: (text: string) => void;
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
    replaceInput,
    cancelInput,
    setNotice,
    cancelQueueEdit,
  } = context;
  const notifyError = (error: unknown) => setNotice(error instanceof Error ? error.message : String(error));
  interrupt.current = () => {
    if (approvalInterrupt?.current?.()) return;
    if (confirmation.pending) confirmation.clear();
    else if (cancelQueueEdit()) return;
    else if (state.activeTurnId || (state.interactions.length && editor.value.length === 0))
      void cancelInput(connection, state.activeTurnId ?? undefined).then(setNotice, notifyError);
    else if (editor.value.length > 0) replaceInput('');
    else setNotice('Press Ctrl+C again to exit');
  };
}
