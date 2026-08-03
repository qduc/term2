/**
 * Single source of truth for "which surface owns keyboard input right now."
 *
 * Ink fans every keypress out to ALL mounted `useInput` hooks. To prevent an
 * app-level shortcut (e.g. Esc → stopProcessing) from firing while a modal
 * confirmation prompt owns the interaction, the app keyboard-shortcuts hook
 * gates itself on `inputOwner.kind === 'input'`.
 *
 * The derivation intentionally mirrors the mutual-exclusivity ordering used by
 * `BottomArea` when deciding which prompt to render, so "who owns input" stays
 * in sync with "what is rendered".
 *
 * Adding a new modal prompt: add a variant to `InputOwner`, handle it here in
 * `deriveInputOwner`, and ensure it returns a non-`'input'` kind so the app hook
 * stays suppressed while that prompt is shown.
 */
export type InputOwner =
  | { kind: 'handoff-confirm' }
  | { kind: 'standard-mode-confirm' }
  | { kind: 'input-surge' }
  | { kind: 'large-uncached' }
  | { kind: 'approval' }
  | { kind: 'queue-paused' }
  | { kind: 'input' };

export type InputOwnerState = {
  handoffStage?: string | null;
  pendingSurgeTurn: unknown | null;
  pendingLargeUncachedTurn: unknown | null;
  waitingForApproval: boolean;
  waitingForRejectionReason: boolean;
  waitingForAskUserAnswer: boolean;
  pendingApproval: unknown | null;
  queuePaused: boolean;
  /**
   * True while the agent is actively processing a turn. Mirrors the original
   * `showApprovalPrompt` guard: the approval prompt only owns input when NOT
   * processing (otherwise no surface owns input).
   */
  isProcessing: boolean;
};

/**
 * Resolve which surface owns input from the current effective app state.
 *
 * Ordering matters: the four standalone confirmation prompts are mutually
 * exclusive (see `BottomArea`'s render chain), and `approval` is only the
 * owner when an approval decision is actually pending — NOT during
 * ask-user-answer or rejection-reason sub-modes, where `InputBox` owns input
 * and the app hook must stay active to cancel those sub-modes on Esc.
 */
export const deriveInputOwner = (state: InputOwnerState): InputOwner => {
  if (state.handoffStage === 'confirm_model') return { kind: 'handoff-confirm' };
  if (state.handoffStage === 'confirm_standard_mode') return { kind: 'standard-mode-confirm' };
  if (state.pendingSurgeTurn) return { kind: 'input-surge' };
  if (state.pendingLargeUncachedTurn) return { kind: 'large-uncached' };
  if (
    state.waitingForApproval &&
    !state.isProcessing &&
    !state.waitingForRejectionReason &&
    !state.waitingForAskUserAnswer &&
    state.pendingApproval
  ) {
    return { kind: 'approval' };
  }
  if (state.queuePaused) return { kind: 'queue-paused' };
  return { kind: 'input' };
};
