// Compatibility export for existing UI tests/imports. Handoff policy is
// owned by the application service; the hook only projects its state.
export {
  createInitialHandoffState,
  composeHandoffMessage,
  handoffFlowReducer,
  type HandoffAction,
  type HandoffStage,
  type HandoffState,
} from '../services/handoff/handoff-flow-reducer.js';
