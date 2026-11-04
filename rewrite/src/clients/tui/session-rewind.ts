import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { TuiConnection } from './integration.js';
import type { useSessionComposer } from './session-composer.js';

/** Execute a rewind under the same pending-send lock as the composer. */
export function useSessionRewind({
  connection,
  pending,
  rewindDraft,
  setBusy,
  viewport,
  setNotice,
}: {
  connection: TuiConnection;
  pending: RefObject<boolean>;
  rewindDraft: ReturnType<typeof useSessionComposer>['rewindDraft'];
  setBusy: Dispatch<SetStateAction<boolean>>;
  viewport: { readonly epoch: number; readonly frameReady?: boolean };
  setNotice: (message: string | null) => void;
}) {
  // Legacy mounts the input box again in the same render that remounts the rewound transcript and draws its held
  // rows, with the draft already in it. The composer stays hidden from the rewind's start until that live frame.
  const [rewindEpoch, setRewindEpoch] = useState<number | null>(null);
  const rewindHidden = rewindEpoch !== null && (rewindEpoch === viewport.epoch || viewport.frameReady === false);
  useEffect(() => {
    if (rewindEpoch !== null && !rewindHidden) setRewindEpoch(null);
  }, [rewindEpoch, rewindHidden]);
  const setRewinding = (phase: 'start' | 'failed') => setRewindEpoch(phase === 'start' ? viewport.epoch : null);
  const executeRewind = async (targetId: string, disposition: 'edit' | 'resend') => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setRewinding('start');
    // No reset: `/undo` prints legacy's alias notice just before this runs.
    try {
      const message = await rewindDraft(connection, targetId, disposition); // legacy says nothing on success
      if (message) {
        setRewinding('failed');
        setNotice(message);
      }
    } catch (error) {
      setRewinding('failed');
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return { executeRewind, rewindHidden };
}
