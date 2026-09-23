interface ClearInputBeforeResetDeps {
  replaceInput: (value: string) => void;
  /** Ink's `useApp().waitUntilRenderFlush`: resolves once pending state has been painted. */
  waitUntilRenderFlush: () => Promise<void>;
}

/**
 * Wrap an action that resets the UI (exit, clear conversation) so the
 * composer is emptied and that frame is painted first. Slash-command
 * dispatch clears the input only after the action returns, which is too late
 * for these: exit unmounts Ink and a clear prints usage above the frame, so
 * the typed `/quit` or `/clear` would otherwise stay on screen.
 *
 * The clear waits one microtask so a synchronous caller (a menu accept
 * handler returning its own buffer/stack effect) settles first; clearing
 * mid-handler would reconcile the menu stack under it.
 */
export function clearInputBeforeReset<Args extends unknown[]>(
  { replaceInput, waitUntilRenderFlush }: ClearInputBeforeResetDeps,
  action: (...args: Args) => void | Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    await Promise.resolve();
    replaceInput('');
    await waitUntilRenderFlush();
    await action(...args);
  };
}
