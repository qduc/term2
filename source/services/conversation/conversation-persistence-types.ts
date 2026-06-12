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

export interface PersistedReasoningItem {
  type: 'reasoning';
  text: string;
  providerMetadata?: Record<string, unknown>;
  providerItemId?: string;
  sequence?: number;
}

export interface PersistedAssistantTextItem {
  type: 'assistant_text';
  text: string;
  providerMetadata?: Record<string, unknown>;
  providerItemId?: string;
}

export interface PersistedToolCallItem {
  type: 'tool_call';
  callId: string;
  toolName: string;
  arguments: unknown;
  providerItem?: Record<string, unknown>;
}

export interface PersistedToolResultItem {
  type: 'tool_result';
  callId: string;
  toolName: string;
  status: 'completed' | 'failed' | 'aborted';
  output: unknown;
  providerItem?: Record<string, unknown>;
}

export type PersistedAssistantTurnItem =
  | PersistedReasoningItem
  | PersistedAssistantTextItem
  | PersistedToolCallItem
  | PersistedToolResultItem;

export interface PersistedAssistantTurn {
  items: PersistedAssistantTurnItem[];
}
