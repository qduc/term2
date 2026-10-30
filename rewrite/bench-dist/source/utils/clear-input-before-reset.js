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
export function clearInputBeforeReset({ replaceInput, waitUntilRenderFlush }, action) {
    return async (...args) => {
        await Promise.resolve();
        replaceInput('');
        await waitUntilRenderFlush();
        await action(...args);
    };
}
//# sourceMappingURL=clear-input-before-reset.js.map