import type { ProviderInput, ProviderInputItem } from '../contracts/provider-input.js';
import type { JsonSchemaDefinition } from '../contracts/model-types.js';
import type { ContinuationHandle } from '../contracts/continuation-handle.js';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import type { ConversationEvent } from './conversation/conversation-events.js';
import type { AgentStream } from './agent-stream.js';
import type { ProviderHistorySnapshot } from './conversation/conversation-store.js';
import type { SteerOutcome } from './agent-runtime/application-run-loop.js';
import type { SubagentCancelAcknowledgement, SubagentRunStatus } from './subagents/types.js';
import type { BackgroundShellJob } from './shell/background-shell-registry.js';
import type { ForegroundShellLeaseDetails, ForegroundShellTransferResult } from './shell/background-shell-registry.js';
import type { BackgroundSubagentApprovalPauseSink } from './subagents/foreground-subagent-lease.js';
import type { ForegroundSubagentCandidate } from './subagents/nested-runner.js';
import type { NestedToolCompatibilityState } from './session/nested-tool-compatibility-state.js';
import type { NormalizedUsage } from '../utils/ai/token-usage.js';
import type { ModelRequestCost } from './cost/model-cost.js';
import type { RunBudgetEvent } from './agent-runtime/run-budget.js';

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
  /**
   * End the continuation once the approved tool's result is recorded, without
   * a further model call. See `ApplicationRunLoopOptions.stopAfterApprovalResolution`.
   */
  stopAfterApprovalResolution?: boolean;
  /** Observational run-budget/stall evidence; delivery policy belongs to the caller. */
  onRunBudgetEvent?: (event: RunBudgetEvent) => void;
};

export type AgentClientChatOptions = {
  model?: string;
  provider?: string;
  reasoningEffort?: ReasoningEffortSetting | null;
  instructions?: string;
  maxTokens?: number;
};

export type AgentClientChatResult = {
  text: string;
  usage?: NormalizedUsage;
  costRecords?: ModelRequestCost[];
};

export type AgentClientChatJsonOptions = AgentClientChatOptions & {
  outputType: JsonSchemaDefinition;
};

export type ToolInterceptor = (name: string, params: unknown, toolCallId?: string) => Promise<string | null>;

export interface ShellAutoApprovalAgentClient {
  chat(message: string, options?: AgentClientChatOptions): Promise<string>;
  chatDetailed?(message: string, options?: AgentClientChatOptions): Promise<AgentClientChatResult>;
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
  /** Conversation-scoped lifecycle sink for root background shell jobs. */
  setBackgroundShellEventSink?(sink: ((event: ConversationEvent) => void) | null): void;
  /** Session-owned queue/control sink for adopted subagent approval pauses. */
  setBackgroundSubagentApprovalPauseSink?(sink: BackgroundSubagentApprovalPauseSink | null): void;
  /** Optional hook to cancel live async subagent runs when the parent turn ends. */
  cancelSubagentRuns?(): void;
}

export interface ConversationAgentClient extends ShellAutoApprovalAgentClient {
  startStream(userInput: ProviderInput, options?: AgentClientRunOptions): Promise<AgentStream>;
  continueRunStream(state: ContinuationHandle, options?: AgentClientRunOptions): Promise<AgentStream>;
  abort(): void;
  /**
   * Mark where a turn begins and ends. Without them the client sees only
   * streams, and a turn's first stream is indistinguishable from a retry of its
   * last — so a steer cannot survive the gaps between them.
   */
  openTurn?(): void;
  closeTurn?(): void;
  /** Grant one finite extension to the active staged run budget. */
  grantRunBudgetExtension?(): { granted: boolean; extensionsGranted: number };
  /** Admit a user message into the running turn at its next request boundary. */
  steer?(items: readonly ProviderInputItem[], options?: { id?: string }): Promise<SteerOutcome>;
  /** Drop a still-waiting steer. False when it was already admitted. */
  retractSteer?(id: string): boolean;
  /** Replace a waiting steer's items in place, keeping its position. */
  editSteer?(id: string, items: readonly ProviderInputItem[]): boolean;
  setModel(model: string): void;
  addToolInterceptor(interceptor: ToolInterceptor): () => void;
  /**
   * Wire session tool-ledger dispatch marking. Called after composition creates
   * the tracker so mid-tool stream recovery can settle as `unknown`.
   */
  setOnToolDispatch?(handler: ((callId: string) => void) | undefined): void;
  /** Conversation-scoped lifecycle sink for root background shell jobs. */
  setBackgroundShellEventSink?(sink: ((event: ConversationEvent) => void) | null): void;

  /**
   * Cancel conversation-bound background (async) subagent runs. Only an
   * explicit user interrupt, conversation disposal, or shutdown may call this;
   * ordinary turn aborts must not.
   */
  cancelBackgroundRuns?(): void;
  /** Cancel root shell jobs without ending the conversation session. */
  cancelBackgroundShellJobs?(): void;
  /** Cancel and settle root shell jobs during session shutdown. */
  disposeBackgroundShellJobs?(): Promise<void>;

  /** Narrow background-task controls; registries remain owned by the root client. */
  getBackgroundSubagentStatus?(runId: string): SubagentRunStatus;
  listBackgroundSubagentStatuses?(): SubagentRunStatus[];
  requestBackgroundSubagentStop?(runId: string): SubagentCancelAcknowledgement;
  /** Foreground candidates that may be transferred without restarting. */
  listForegroundSubagentCandidates?(): ForegroundSubagentCandidate[];
  /** Atomically adopts one foreground child into the background registry. */
  moveForegroundSubagent?(
    runId: string,
  ): { runId: string; role: string; name?: string; status: 'running'; task: string } | undefined;
  /** Exact compatibility state shared with nested execution. */
  getNestedToolCompatibilityState?(): NestedToolCompatibilityState | undefined;
  /** Cancel and await adopted leases before detaching background sinks. */
  disposeBackgroundSubagents?(): Promise<void>;
  getBackgroundShellJob?(jobId: string): BackgroundShellJob<unknown> | undefined;
  listBackgroundShellJobs?(): BackgroundShellJob<unknown>[];
  requestBackgroundShellStop?(jobId: string): boolean;
  /** The currently running root shell call that can be detached from its turn. */
  getForegroundShellTransferCandidate?(): ForegroundShellLeaseDetails | undefined;
  /** Atomically adopts a root shell call into the session background registry. */
  moveForegroundShellToBackground?(callId: string): ForegroundShellTransferResult | undefined;

  clearConversations?(): void;
  getProvider?(): string;
  supportsConversationChaining?(): boolean;
  setProvider?(provider: string): void;
  setReasoningEffort?(effort?: ReasoningEffortSetting): void;
  setRetryCallback?(callback: () => void): void;
  setTemperature?(temperature?: number): void;
  /**
   * Force the next request to the standard (non-flex) service tier. The
   * override is one-shot: it is consumed by the next request it applies to.
   */
  useStandardServiceTierForNextRequest?(): void;
}
