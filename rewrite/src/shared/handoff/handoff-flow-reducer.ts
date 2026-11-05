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

export function composeHandoffMessage(state: HandoffState): string {
  return `${state.handoffMessage || 'Implement this'}:\n\n${state.capturedText}`;
}

export function handoffFlowReducer(state: HandoffState | null, action: HandoffAction): HandoffState | null {
  switch (action.type) {
    case 'handoff/started':
      return { capturedText: action.capturedText, stage: 'entering_message' };
    case 'handoff/message_captured':
      return state?.stage === 'entering_message'
        ? { ...state, handoffMessage: action.handoffMessage, stage: 'confirm_model' }
        : state;
    case 'handoff/model_confirmed':
      return state ? { ...state, stage: 'selecting_model' } : state;
    case 'handoff/model_selected':
      return state?.stage === 'selecting_model' ? { ...state, stage: 'selecting_effort' } : state;
    case 'handoff/standard_mode_requested':
      return state ? { ...state, stage: 'confirm_standard_mode' } : state;
    case 'handoff/sent':
    case 'handoff/cancelled':
      return state ? null : state;
  }
}
