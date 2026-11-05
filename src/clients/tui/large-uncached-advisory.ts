import { useEffect, useRef, useState } from 'react';
import { previewSendHold } from './commands.js';
import type { TuiConnection } from './integration.js';
import type { LargeUncachedStatus } from './composer-footer.js';

/** Legacy app.tsx's LARGE_UNCACHED_PREVIEW_DEBOUNCE_MS. */
const PREVIEW_DEBOUNCE_MS = 250;

/**
 * Legacy app.tsx's largeUncachedWarning: while idle, a debounced preview of the composer text
 * drives the status bar's `cache miss risk ~Nk`; a held send turns it into `confirm cache miss ~Nk`.
 */
export function useLargeUncachedAdvisory(
  connection: TuiConnection,
  input: string,
  textMode: boolean,
  { activeTurnId }: { readonly activeTurnId?: string | null },
  held: { readonly largeTokens: number | undefined; readonly surgePending: boolean },
): LargeUncachedStatus {
  // Legacy's useDebouncedValue, flushed at once when the composer empties.
  const [previewInput, setPreviewInput] = useState(input);
  useEffect(() => {
    if (input === '') return setPreviewInput('');
    const timer = setTimeout(() => setPreviewInput(input), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);
  const [estimate, setEstimate] = useState<number | undefined>(undefined);
  const latest = useRef(0);
  const skip = !previewInput || !textMode || previewInput.startsWith('/') || Boolean(activeTurnId);
  useEffect(() => {
    const request = ++latest.current;
    if (skip) {
      setEstimate(undefined);
      return;
    }
    previewSendHold(connection, previewInput).then(
      (hold) => request === latest.current && setEstimate(hold?.largeTokens),
      () => request === latest.current && setEstimate(undefined),
    );
  }, [connection, previewInput, skip]);
  // Drop the advisory on the same render that empties the composer, leaves text mode or starts processing.
  return {
    estimatedTokens: skip ? undefined : estimate,
    pending: held.largeTokens !== undefined || held.surgePending,
    pendingTokens: held.largeTokens,
  };
}
