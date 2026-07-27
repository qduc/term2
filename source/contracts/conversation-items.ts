/** Serializable assistant-turn data independent of any provider SDK. */
export interface ReasoningItem {
  type: 'reasoning';
  text: string;
  providerMetadata?: Record<string, unknown>;
  providerItemId?: string;
  sequence?: number;
}

export interface AssistantTextItem {
  type: 'assistant_text';
  text: string;
  providerMetadata?: Record<string, unknown>;
  providerItemId?: string;
}

export interface ToolCall {
  type: 'tool_call';
  callId: string;
  toolName: string;
  arguments: unknown;
  providerItem?: Record<string, unknown>;
}

export interface ToolResult {
  type: 'tool_result';
  callId: string;
  toolName: string;
  status: 'completed' | 'failed' | 'aborted';
  output: unknown;
  providerItem?: Record<string, unknown>;
}

export type Item = ReasoningItem | AssistantTextItem | ToolCall | ToolResult;

export interface Turn {
  items: Item[];
}
