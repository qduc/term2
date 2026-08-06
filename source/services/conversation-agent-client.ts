import type { ProviderInput, ProviderInputItem } from '../contracts/provider-input.js';
import type { JsonSchemaDefinition } from '../contracts/model-types.js';
import type { ContinuationHandle } from '../contracts/continuation-handle.js';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import type { ConversationEvent } from './conversation/conversation-events.js';
import type { AgentStream } from './agent-stream.js';
import type { ProviderHistorySnapshot } from './conversation/conversation-store.js';
import type { SteerOutcome } from './agent-runtime/application-run-loop.js';

export type AgentClientRunOptions = {
  previousResponseId?: string | null;
  sessionId?: string;
  toolResultCallIds?: readonly string[];
  knownToolCallIds?: readonly string[];
  /** Immutable, out-of-band authoritative history for provider compatibility seams. */
  providerHistorySnapshot?: ProviderHistorySnapshot;
  /** Provider continuity epoch frozen while this request is planned. */
  providerContinuityLineage?: number;
  /** Internal public-hook correlation for the logical foreground turn. */
  hookTurnId?: string;
};

export type AgentClientChatOptions = {
  model?: string;
  provider?: string;
  reasoningEffort?: ReasoningEffortSetting | null;
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
  startStream(userInput: ProviderInput, options?: AgentClientRunOptions): Promise<AgentStream>;
  continueRunStream(state: ContinuationHandle, options?: AgentClientRunOptions): Promise<AgentStream>;
  abort(): void;
  /** Admit a user message into the running turn at its next request boundary. */
  steer?(items: readonly ProviderInputItem[], options?: { id?: string }): Promise<SteerOutcome>;
  /** Drop a still-waiting steer. False when it was already admitted. */
  retractSteer?(id: string): boolean;
  /** Replace a waiting steer's items in place, keeping its position. */
  editSteer?(id: string, items: readonly ProviderInputItem[]): boolean;
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
