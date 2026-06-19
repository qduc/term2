/**
 * Adapter bridge – the only file in the session directory that imports
 * ConversationAdapter. This keeps session-composition.ts free of the
 * conversation-layer import while still allowing the composition to
 * construct and return the adapter for backward compatibility.
 *
 * Long-term: this bridge can be removed once all callers migrate to
 * createSessionRuntime() or the conversation-layer factory.
 */
export { ConversationAdapter } from '../conversation/conversation-adapter.js';
export type {
  SendMessageOptions,
  HandleApprovalDecisionOptions,
  TurnFlow,
} from '../conversation/conversation-adapter.js';
