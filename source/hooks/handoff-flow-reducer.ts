/**
 * Reducer for the handoff flow state machine.
 *
 * Pure transitions only — all I/O (settings writes, sending messages, clearing
 * the conversation) lives in the consuming `useHandoffFlow` hook, which dispatches
 * these actions. Matches the established `conversation-ui-reducer.ts` convention:
 * `domain/event` action types, a tagged-union stage, an exported pure reducer, an
 * initial-state factory, and a transition guard inside each `case`.
 */

export type HandoffStage =
  | 'entering_message'
  | 'confirm_model'
  | 'selecting_model'
  | 'selecting_effort'
  | 'confirm_standard_mode';

export interface HandoffState {
  capturedText: string;
  stage: HandoffStage;
  handoffMessage?: string;
}

export type HandoffAction =
  | { type: 'handoff/started'; capturedText: string }
  | { type: 'handoff/message_captured'; handoffMessage: string }
  | { type: 'handoff/model_confirmed' }
  | { type: 'handoff/model_selected' }
  | { type: 'handoff/standard_mode_requested' }
  | { type: 'handoff/sent' }
  | { type: 'handoff/cancelled' };

export function createInitialHandoffState(): HandoffState | null {
  return null;
}

/** Composes the message sent to the agent from the captured handoff text. */
export function composeHandoffMessage(state: HandoffState): string {
  return `${state.handoffMessage || 'Implement this'}:\n\n${state.capturedText}`;
}

export function handoffFlowReducer(state: HandoffState | null, action: HandoffAction): HandoffState | null {
  switch (action.type) {
    case 'handoff/started':
      return { capturedText: action.capturedText, stage: 'entering_message' };

    case 'handoff/message_captured':
      if (state?.stage !== 'entering_message') {
        return state;
      }
      return { ...state, handoffMessage: action.handoffMessage, stage: 'confirm_model' };

    case 'handoff/model_confirmed':
      // Mirrors the original hook: confirmHandoff transitions from any
      // non-null stage (it is only invoked from confirm_model in production,
      // but the public method itself is stage-agnostic).
      if (!state) {
        return state;
      }
      return { ...state, stage: 'selecting_model' };

    case 'handoff/model_selected':
      if (state?.stage !== 'selecting_model') {
        return state;
      }
      return { ...state, stage: 'selecting_effort' };

    case 'handoff/standard_mode_requested':
      if (!state) {
        return state;
      }
      return { ...state, stage: 'confirm_standard_mode' };

    case 'handoff/sent':
      if (!state) {
        return state;
      }
      return null;

    case 'handoff/cancelled':
      if (!state) {
        return state;
      }
      return null;

    default:
      return state;
  }
}
