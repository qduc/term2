import type { AgentInputItem, RunState } from '@openai/agents';
import type { JsonSchemaDefinition } from '@openai/agents';
import type { ModelSettingsReasoningEffort } from '@openai/agents-core/model';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import type { ConversationEvent } from './conversation-events.js';
import type { AgentStream } from './agent-stream.js';

export type AgentClientRunOptions = {
  previousResponseId?: string | null;
  sessionId?: string;
  toolResultCallIds?: readonly string[];
};

export type AgentClientChatOptions = {
  model?: string;
  provider?: string;
  reasoningEffort?: ModelSettingsReasoningEffort | 'default';
  instructions?: string;
};

export type AgentClientChatJsonOptions = AgentClientChatOptions & {
  outputType: JsonSchemaDefinition;
};

export type ToolInterceptor = (name: string, params: unknown, toolCallId?: string) => Promise<string | null>;

export interface ShellAutoApprovalAgentClient {
  chat(message: string, options?: AgentClientChatOptions): Promise<string>;
  chatJson?(message: string, options: AgentClientChatJsonOptions): Promise<unknown>;
}

export interface ConversationAgentClient extends ShellAutoApprovalAgentClient {
  startStream(
    userInput: string | AgentInputItem | AgentInputItem[],
    options?: AgentClientRunOptions,
  ): Promise<AgentStream>;
  continueRunStream(state: RunState<any, any>, options?: AgentClientRunOptions): Promise<AgentStream>;
  abort(): void;
  setModel(model: string): void;
  setAskUserAnswer(callId: string, answer: string): void;
  addToolInterceptor(interceptor: ToolInterceptor): () => void;

  clearConversations?(): void;
  forceTransportDowngrade?(error: unknown): boolean;
  getProvider?(): string;
  getStreamMaxRetries?(): number | undefined;
  onDowngrade?(callback: () => void): (() => void) | void;
  setProvider?(provider: string): void;
  setReasoningEffort?(effort?: ReasoningEffortSetting): void;
  setRetryCallback?(callback: () => void): void;
  setSubagentEventSink?(sink: ((event: ConversationEvent) => void) | null): void;
  setTemperature?(temperature?: number): void;
  shouldRetryWithoutFlexServiceTier?(error: unknown): boolean;
  useStandardServiceTierForNextRequest?(): void;
}
