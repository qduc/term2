/**
 * Resolve which surface owns input from the current effective app state.
 *
 * Ordering matters: the four standalone confirmation prompts are mutually
 * exclusive (see `BottomArea`'s render chain), and `approval` is only the
 * owner when an approval decision is actually pending — NOT during
 * ask-user-answer or rejection-reason sub-modes, where `InputBox` owns input
 * and the app hook must stay active to cancel those sub-modes on Esc.
 */
export const deriveInputOwner = (state) => {
    if (state.handoffStage === 'confirm_model')
        return { kind: 'handoff-confirm' };
    if (state.handoffStage === 'confirm_standard_mode')
        return { kind: 'standard-mode-confirm' };
    if (state.pendingModeSwitch)
        return { kind: 'mode-switch-confirm' };
    if (state.pendingSurgeTurn)
        return { kind: 'input-surge' };
    if (state.pendingLargeUncachedTurn)
        return { kind: 'large-uncached' };
    if (state.waitingForApproval &&
        !state.isProcessing &&
        !state.waitingForRejectionReason &&
        !state.waitingForAskUserAnswer &&
        state.pendingApproval) {
        return { kind: 'approval' };
    }
    // The gate owns the boundary before its menu mounts, but once the provider
    // or model surface is visible that menu becomes the sole keyboard consumer.
    // This keeps the composer blocked without deadlocking the setup flow.
    if (state.firstRunSetupActive && !state.menuOpen)
        return { kind: 'first-run-setup' };
    if (state.menuOpen)
        return { kind: 'menu' };
    if (state.queuePaused && !state.inputValue?.startsWith('/'))
        return { kind: 'queue-paused' };
    if (state.backgroundTaskManagerOpen)
        return { kind: 'background-tasks' };
    return { kind: 'input' };
};
//# sourceMappingURL=input-owner.js.map