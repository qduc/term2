import type { AgentInputItem, RunState } from '@openai/agents';
import type { JsonSchemaDefinition } from '@openai/agents';
import type { ModelSettingsReasoningEffort } from '@openai/agents-core/model';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import type { ConversationEvent } from './conversation/conversation-events.js';
import type { AgentStream } from './agent-stream.js';
import type { ProviderHistorySnapshot } from './conversation/conversation-store.js';

export type AgentClientRunOptions = {
  previousResponseId?: string | null;
  sessionId?: string;
  toolResultCallIds?: readonly string[];
  knownToolCallIds?: readonly string[];
  /** Immutable, out-of-band authoritative history for provider compatibility seams. */
  providerHistorySnapshot?: ProviderHistorySnapshot;
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

export interface AskUserAnswerSink {
  setAskUserAnswer(callId: string, answer: string): void;
}

export interface SubagentEventSinkHost {
  setSubagentEventSink(sink: ((event: ConversationEvent) => void) | null): void;
  /**
   * Optional conversation-scoped sink that stays attached across turns, so
   * background (async) subagent activity is still observed while idle.
   */
  setBackgroundSubagentEventSink?(sink: ((event: ConversationEvent) => void) | null): void;
  /** Optional hook to cancel live async subagent runs when the parent turn ends. */
  cancelSubagentRuns?(): void;
}

export interface ConversationAgentClient extends ShellAutoApprovalAgentClient {
  startStream(
    userInput: string | AgentInputItem | AgentInputItem[],
    options?: AgentClientRunOptions,
  ): Promise<AgentStream>;
  continueRunStream(state: RunState<any, any>, options?: AgentClientRunOptions): Promise<AgentStream>;
  abort(): void;
  setModel(model: string): void;
  addToolInterceptor(interceptor: ToolInterceptor): () => void;

  /**
   * Cancel conversation-bound background (async) subagent runs. Only an
   * explicit user interrupt, conversation disposal, or shutdown may call this;
   * ordinary turn aborts must not.
   */
  cancelBackgroundRuns?(): void;

  clearConversations?(): void;
  getProvider?(): string;
  supportsConversationChaining?(): boolean;
  setProvider?(provider: string): void;
  setReasoningEffort?(effort?: ReasoningEffortSetting): void;
  setRetryCallback?(callback: () => void): void;
  setTemperature?(temperature?: number): void;
}
