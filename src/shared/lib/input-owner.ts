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
  | { kind: 'mode-switch-confirm' }
  | { kind: 'input-surge' }
  | { kind: 'large-uncached' }
  | { kind: 'approval' }
  | { kind: 'queue-paused' }
  | { kind: 'background-tasks' }
  | { kind: 'first-run-setup' }
  | { kind: 'menu' }
  | { kind: 'input' };

export type InputOwnerState = {
  handoffStage?: string | null;
  pendingModeSwitch?: unknown | null;
  pendingSurgeTurn: unknown | null;
  pendingLargeUncachedTurn: unknown | null;
  waitingForApproval: boolean;
  waitingForRejectionReason: boolean;
  waitingForAskUserAnswer: boolean;
  pendingApproval: unknown | null;
  queuePaused: boolean;
  /** Slash commands remain reachable without resuming or discarding paused work. */
  inputValue: string;
  backgroundTaskManagerOpen?: boolean;
  firstRunSetupActive?: boolean;
  menuOpen?: boolean;
  /**
   * True while the agent is actively processing a turn. Mirrors the original
   * `showApprovalPrompt` guard: the approval prompt only owns input when NOT
   * processing (otherwise no surface owns input).
   */
  isProcessing: boolean;
};
