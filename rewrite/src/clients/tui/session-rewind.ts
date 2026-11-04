import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { WireRewindTarget } from '../../protocol/direct-wire.js';
import type { TuiConnection } from './integration.js';
import type { useSessionComposer } from './session-composer.js';

/** Execute a rewind under the same pending-send lock as the composer. */
export function useSessionRewind({
  connection,
  pending,
  rewindDraft,
  setBusy,
  setNotice,
  setRewindTargets,
}: {
  connection: TuiConnection;
  pending: RefObject<boolean>;
  rewindDraft: ReturnType<typeof useSessionComposer>['rewindDraft'];
  setBusy: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  setRewindTargets: Dispatch<SetStateAction<readonly WireRewindTarget[] | null>>;
}) {
  return async (targetId: string, disposition: 'edit' | 'resend') => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice(null);
    setRewindTargets(null);
    try {
      setNotice(await rewindDraft(connection, targetId, disposition));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
}
