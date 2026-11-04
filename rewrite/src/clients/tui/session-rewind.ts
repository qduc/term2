import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { TuiConnection } from './integration.js';
import type { useSessionComposer } from './session-composer.js';

/** Execute a rewind under the same pending-send lock as the composer. */
export function useSessionRewind({
  connection,
  pending,
  rewindDraft,
  setBusy,
  setNotice,
}: {
  connection: TuiConnection;
  pending: RefObject<boolean>;
  rewindDraft: ReturnType<typeof useSessionComposer>['rewindDraft'];
  setBusy: Dispatch<SetStateAction<boolean>>;
  setNotice: (text: string | null) => void;
}) {
  return async (targetId: string, disposition: 'edit' | 'resend') => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    // No reset: `/undo` prints legacy's alias notice just before this runs.
    try {
      const message = await rewindDraft(connection, targetId, disposition); // legacy says nothing on success
      if (message) setNotice(message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
}
