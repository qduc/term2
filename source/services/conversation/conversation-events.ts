import type { CommandMessage } from '../../tools/types.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { ApprovalDescriptor, LLMAdvisory } from '../../contracts/conversation.js';
import type { SubagentResult } from '../subagents/types.js';
import type { PersistedAssistantTurnItem } from './conversation-persistence-types.js';
import type { CodexRateLimitInfo } from '../../contracts/streamed-model-turn.js';
export type { CodexRateLimitInfo, CodexRateLimitWindow } from '../../contracts/streamed-model-turn.js';

export type ConversationEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolStartedEvent
  | ToolCallStreamingDeltaEvent
  | CommandMessageEvent
  | ApprovalRequiredEvent
  | UsageUpdateEvent
  | FinalResponseEvent
  | ErrorEvent
  | RetryEvent
  | ToolRecoveryEvent
  | SubagentStartedEvent
  | SubagentToolStartedEvent
  | SubagentTextTurnEvent
  | SubagentStreamingTextEvent
  | SubagentCommandMessageEvent
  | SubagentCompletedEvent
  | SubagentQuestionEvent
  | CodexRateLimitEvent
  | UserMessageConsumedForAbortEvent
  | ContextCompactionStartedEvent
  | ContextCompactionCompletedEvent
  | ContextCompactionFailedEvent;

export interface RetryEvent {
  type: 'retry';
  toolName: string;
  attempt: number;
  maxRetries: number;
  errorMessage: string;
  retryType?: 'hallucination' | 'parsing_error' | 'behavior' | 'flex_service_tier' | 'upstream';
}

export interface ToolRecoveryEvent {
  type: 'tool_recovery';
  recoveredCallIds: string[];
  droppedCallIds: string[];
  message: string;
}

/**
 * Transport-friendly text streaming event.
 *
 * - `delta` is the new chunk.
 * - `fullText` is the accumulated text so far (optional but convenient for UIs).
 */
export interface TextDeltaEvent {
  type: 'text_delta';
  delta: string;
  fullText?: string;
}

/**
 * Transport-friendly reasoning streaming event.
 */
export interface ReasoningDeltaEvent {
  type: 'reasoning_delta';
  delta: string;
  fullText?: string;
}

/**
 * Emitted when a tool is called but hasn't completed yet.
 * Allows UI to show immediate feedback that a tool is running.
 */
export interface ToolStartedEvent {
  type: 'tool_started';
  toolCallId: string;
  toolName: string;
  arguments: unknown;
}

/**
 * Emitted while the model is streaming tool call arguments.
 * Allows the UI to show progress before the full tool call arrives.
 */
export interface ToolCallStreamingDeltaEvent {
  type: 'tool_call_streaming_delta';
  /** Tool name, if known (available earlier on Responses API). */
  toolName?: string;
  /** Cumulative character count of streamed arguments so far. */
  argumentCharCount: number;
}

export interface ApprovalRequiredEvent {
  type: 'approval_required';
  approval: Omit<ApprovalDescriptor, 'rawInterruption'> & {
    llmAdvisory?: LLMAdvisory;
  };
  /** Token usage for the model turn that requested approval. */
  usage?: NormalizedUsage;
}

/**
 * Emitted when token usage information is received during streaming.
 * Allows UI to display token usage in real-time rather than waiting for final response.
 */
export interface UsageUpdateEvent {
  type: 'usage_update';
  usage: NormalizedUsage;
}

export interface CommandMessageEvent {
  type: 'command_message';
  message: CommandMessage;
}

export interface FinalResponseEvent {
  type: 'final';
  finalText: string;
  reasoningText?: string;
  /** Command messages that were not already streamed live. */
  commandMessages?: CommandMessageEvent['message'][];
  /** Token usage for this turn. */
  usage?: NormalizedUsage;
  turnItems?: PersistedAssistantTurnItem[];
}

export interface ErrorEvent {
  type: 'error';
  message: string;
  kind?: string;
  stack?: string;
  /**
   * Set when the session removed the just-added user turn from its store as part of
   * handling this error. UIs should drop the corresponding trailing user message and
   * restore the text to the input box so the user can edit and retry.
   */
  droppedUserMessage?: { text: string; imageCount: number };
}

/**
 * Emitted when the user's input was consumed as resolution for a previously aborted
 * tool approval rather than added to the conversation as a new user turn. UIs should
 * mark the corresponding user message so /undo and the undo menu skip it.
 */
export interface UserMessageConsumedForAbortEvent {
  type: 'user_message_consumed_for_abort';
}

export interface SubagentStartedEvent {
  type: 'subagent_started';
  agentId: string;
  /** Optional user-provided alias for this async run. */
  name?: string;
  role: string;
  task: string;
  parentTool?: string;
  /** True when this run was started via `run_subagent_async` and is still live. */
  async?: boolean;
}

export interface SubagentToolStartedEvent {
  type: 'subagent_tool_started';
  agentId: string;
  role: string;
  toolCallId: string;
  toolName: string;
  arguments?: unknown;
  commandMessages?: CommandMessage[];
}

/** A completed slice of a subagent's streamed text, for non-blocking progress peeks. */
export interface SubagentTextTurnEvent {
  type: 'subagent_text_turn';
  agentId: string;
  role: string;
  text: string;
}

/** Lightweight in-flight text update for peek — overwrites, does not accumulate. */
export interface SubagentStreamingTextEvent {
  type: 'subagent_streaming_text';
  agentId: string;
  text: string;
}

export interface SubagentCommandMessageEvent {
  type: 'subagent_command_message';
  agentId: string;
  role: string;
  message: CommandMessage;
}

export interface SubagentCompletedEvent {
  type: 'subagent_completed';
  result: SubagentResult;
  /** True when this completion finishes an async run started by `run_subagent_async`. */
  async?: boolean;
}

/** A bounded blocker from a live async execution segment to its orchestrator. */
export interface SubagentQuestionEvent {
  type: 'subagent_question';
  /** This event is only emitted by the async-run registry. */
  async: true;
  messageId: string;
  runId: string;
  name?: string;
  role: string;
  question: string;
}

/** Emitted when Codex reports ChatGPT plan usage limits. */
export interface CodexRateLimitEvent {
  type: 'codex_rate_limits';
  rateLimits: CodexRateLimitInfo;
}

export interface ContextCompactionStartedEvent {
  type: 'context_compaction_started';
  provider: string;
  sessionId: string;
  inputTokensBefore?: number;
}

export interface ContextCompactionCompletedEvent {
  type: 'context_compaction_completed';
  provider: string;
  sessionId: string;
  inputTokensBefore?: number;
  inputTokensAfter?: number;
  durationMs: number;
}

export interface ContextCompactionFailedEvent {
  type: 'context_compaction_failed';
  provider: string;
  sessionId: string;
  errorCategory: 'request' | 'validation' | 'persistence';
  durationMs: number;
}
