/** Direct runtime contracts. Live acceptance tokens are never persisted. */
import type { Item, ModelError, ModelRef, ModelRegistry, ReasoningEffort, ToolCallId, ToolSpec, Usage } from '../model/index.js';
import type { ExecutionId, InteractionDecision, InteractionRequestId, ToolContext, ToolInteractionRequest, ToolRegistry, ToolResult } from '../tools/index.js';
import type { TurnId } from './index.js';

export type { ExecutionId, InteractionDecision, InteractionRequestId } from '../tools/index.js';

export type TurnSpec = {
  readonly turnId: TurnId;
  readonly history: readonly Item[];
  readonly newItems: readonly Item[];
  readonly instructions: string;
  readonly model: ModelRef;
  readonly tools: readonly ToolSpec[];
  readonly reasoning?: ReasoningEffort;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
};
export type TurnResult =
  | { readonly kind: 'completed' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly error: ModelError };
export type InteractionRequest = ToolInteractionRequest & {
  readonly requestId: InteractionRequestId;
  readonly turnId: TurnId;
  readonly executionId?: ExecutionId;
  readonly parentExecutionId?: ExecutionId;
};
export type ToolContextSeed = Pick<ToolContext, 'workspace' | 'settings'>;
export type TurnDeps = {
  readonly models: ModelRegistry;
  readonly tools?: ToolRegistry;
  readonly toolContext?: ToolContextSeed;
  readonly maxParallelToolCalls?: number;
};
export type TurnEvent =
  | { readonly type: 'text_delta'; readonly delta: string; readonly modelStep?: number }
  | { readonly type: 'reasoning_delta'; readonly delta: string }
  | { readonly type: 'item'; readonly item: Item; readonly executionId?: ExecutionId; readonly modelStep?: number }
  | { readonly type: 'usage'; readonly usage: Usage; readonly modelStep?: number }
  | { readonly type: 'tool_called'; readonly executionId: ExecutionId; readonly callId: ToolCallId; readonly toolName: string; readonly input: unknown }
  | { readonly type: 'tool_start_requested'; readonly executionId: ExecutionId; readonly parentExecutionId?: ExecutionId; readonly callId: ToolCallId; readonly toolName: string; readonly input: unknown }
  | { readonly type: 'tool_progress'; readonly executionId: ExecutionId; readonly chunk: string }
  | { readonly type: 'tool_execution_finished'; readonly executionId: ExecutionId; readonly result: ToolResult }
  | { readonly type: 'interaction_required'; readonly request: InteractionRequest }
  | { readonly type: 'turn_ended'; readonly result: TurnResult };
export type AcceptedTurnEvent = { readonly token: number; readonly event: TurnEvent };
/** Only Session accepts events, after their durable facts have committed. */
export type TurnHandle = {
  readonly events: AsyncIterable<AcceptedTurnEvent>;
  accept(token: number): void;
  answer(requestId: InteractionRequestId, decision: InteractionDecision): void;
  cancel(): void;
};
