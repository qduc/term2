export function createInitialHandoffState() {
    return null;
}
export function composeHandoffMessage(state) {
    return `${state.handoffMessage || 'Implement this'}:\n\n${state.capturedText}`;
}
export function handoffFlowReducer(state, action) {
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
//# sourceMappingURL=handoff-flow-reducer.js.map