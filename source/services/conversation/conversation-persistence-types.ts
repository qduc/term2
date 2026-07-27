import type {
  AssistantTextItem,
  Item,
  ReasoningItem,
  ToolCall,
  ToolResult,
  Turn,
} from '../../contracts/conversation-items.js';

export interface SavedMessage {
  id: string;
  sender: string;
  text?: string;
  [key: string]: unknown;
}

export interface SavedAppMode {
  mentorMode: boolean;
  liteMode: boolean;
  planMode: boolean;
  /** Optional: absent in saves from before orchestrator mode was introduced. Treat undefined as false. */
  orchestratorMode?: boolean;
}

/** @deprecated Use the canonical contract types from `contracts/conversation-items`. */
export type PersistedReasoningItem = ReasoningItem;
/** @deprecated Use the canonical contract types from `contracts/conversation-items`. */
export type PersistedAssistantTextItem = AssistantTextItem;
/** @deprecated Use the canonical contract types from `contracts/conversation-items`. */
export type PersistedToolCallItem = ToolCall;
/** @deprecated Use the canonical contract types from `contracts/conversation-items`. */
export type PersistedToolResultItem = ToolResult;
/** @deprecated Use `Item` from `contracts/conversation-items`. */
export type PersistedAssistantTurnItem = Item;
/** @deprecated Use `Turn` from `contracts/conversation-items`. */
export type PersistedAssistantTurn = Turn;
