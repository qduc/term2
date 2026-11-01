/**
 * tools/ — what the agent can do.
 *
 * Each tool carries its schema, its own approval policy and its execute
 * function. Tools know nothing about UIs, sessions or transports.
 * Depends on: model (ToolSpec), config.
 */

import type { Item, ToolSpec, ModelRef, ModelError, ReasoningEffort } from '../model/index.js';
import type { SettingsReader } from '../config/index.js';

export type Workspace = {
  readonly root: string;
  readonly access: 'read' | 'read_write';
  /** 'local' or a remote target such as an SSH host id. */
  readonly target: string;
};

export type NestedRunBudget =
  | { readonly kind?: 'native'; readonly maxModelCalls: number; readonly maxToolCalls: number }
  | { readonly kind: 'adopted' };

export type NestedRunOutcome =
  | { readonly kind: 'background'; readonly runId: string }
  | { readonly kind: 'completed' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'budget_exhausted' }
  | {
      readonly kind: 'interrupted';
      readonly terminalCause?: 'goal_check_unresolved' | 'completion_verification_blocked';
    }
  | { readonly kind: 'failed'; readonly error: ModelError };

/** Public task data supplied by the owning Session, never a tool-owned task map. */
export type SubagentTaskState = {
  readonly taskId: string;
  readonly sessionId: string;
  readonly kind: 'subagent';
  readonly label: string;
  /** Exact caller-provided task input, not a display label or reconstructed history. */
  readonly input?: string;
  readonly name?: string;
  readonly role?: string;
  readonly model?: ModelRef;
  readonly workspace?: Workspace;
  readonly parentTurnId: string;
  readonly parentExecutionId?: ExecutionId;
  readonly sourceCallId?: string;
  readonly origin?: unknown;
  readonly mode: 'foreground' | 'background';
  readonly status:
    | 'running'
    | 'waiting_for_answer'
    | 'cancelling'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'interrupted';
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly completedAt?: number;
  readonly result?:
    | { readonly kind: 'completed'; readonly value: unknown }
    | { readonly kind: 'cancelled'; readonly value?: unknown }
    | { readonly kind: 'failed'; readonly error: ModelError; readonly value?: unknown }
    | { readonly kind: 'interrupted'; readonly reason: string; readonly value?: unknown };
  readonly pendingInteractions: readonly unknown[];
};
export type SubagentMessageResult =
  | { readonly ok: true; readonly runId: string; readonly status: 'running'; readonly delivery: 'answered' }
  | {
      readonly ok: false;
      readonly target: string;
      readonly code:
        | 'not_active'
        | 'unsupported_control'
        | 'invalid_guidance'
        | 'question_not_pending'
        | 'question_mismatch'
        | 'question_pending';
    };
export type SubagentTaskPort = {
  list(): readonly SubagentTaskState[];
  get(target: string): SubagentTaskState | undefined;
  /** Abort only this waiter; cancellation of the child is a distinct explicit operation. */
  wait(target: string, signal: AbortSignal): Promise<SubagentTaskState | undefined>;
  cancel(target: string): { readonly ok: boolean; readonly code?: string };
  message(target: string, message: string, replyTo?: string): SubagentMessageResult;
};
export type NestedRunRequest = {
  /** Original caller task input, preserved separately from resolved instructions/history. */
  readonly input?: string;
  readonly mode?: 'foreground' | 'background';
  readonly name?: string;
  readonly role?: string;
  readonly label?: string;
  readonly maxOutputTokens?: number;
  readonly instructions: string;
  readonly items: readonly Item[];
  readonly toolNames: readonly string[];
  readonly model: ModelRef;
  readonly reasoning?: ReasoningEffort;
  readonly budget: NestedRunBudget;
};
export type NestedRunResult = {
  readonly runId?: string;
  /** Distinct tool names with accepted physical start receipts in this branch, in first-start order. */
  readonly toolsUsed?: readonly string[];
  /** Counts of accepted branch-local physical starts, including scripted leaves.
   * Not successful bodies, offered tools, descendants, or adapter-entry estimates.
   * Absent means unknown; an accepted settled branch with no starts returns []. */
  readonly toolUseCounts?: readonly { readonly toolName: string; readonly count: number }[];
  readonly items: readonly Item[];
  readonly outcome: NestedRunOutcome;
};

export type ExecutionId = string & { readonly __brand: 'ExecutionId' };
export type InteractionRequestId = string & { readonly __brand: 'InteractionRequestId' };
export type InteractionDecision = (
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason?: string }
  | { readonly kind: 'answer'; readonly answer: string }
) & {
  /** Settle this selected decision/body/result, then stop later work/model continuation.
   * This is not cancellation. An empty question answer records the unanswered result. */
  readonly stopAfterApprovalResolution?: boolean;
};
export type ToolInteractionRequest = {
  readonly kind: 'approval' | 'question';
  readonly toolName: string;
  readonly input: unknown;
  readonly sourceCallId?: string;
  readonly summary: string;
  readonly detail?: string;
  readonly risk?: Risk;
  /** Serializable tool-specific approval/question presentation, never live callbacks. */
  readonly presentation?: Readonly<Record<string, unknown>>;
};

/** Session-owned shell process lease. Admission precedes run; settlement includes cleanup. */
export type ShellTaskPort = {
  start<T>(request: ShellTaskStart<T>): {
    readonly id: string;
    readonly startedAt: number;
    readonly settled: Promise<ShellTaskState>;
    readonly foreground: Promise<{ readonly kind: 'result'; readonly value: T } | { readonly kind: 'background' }>;
  };
  get(id: string): ShellTaskState | undefined;
  list(): readonly ShellTaskState[];
  cancel(id: string): boolean;
  output(id: string, chunk: string): boolean;
  notify(id: string, key: string, text: string): boolean;
};
export type ShellTaskStart<T> = {
  readonly command: string;
  readonly mode: 'foreground' | 'background';
  readonly run: (signal: AbortSignal) => Promise<T>;
  readonly cleanup?: () => Promise<void> | void;
  readonly status?: (value: T) => 'completed' | 'failed' | 'timed_out';
};
export type ShellTaskState = {
  readonly id: string;
  readonly command: string;
  readonly mode: 'foreground' | 'background';
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly status: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  readonly value?: unknown;
  readonly error?: string;
};

export type ToolContext = {
  /** Runs a subagent. The engine injects it, so tools never import engine/. */
  runNested(request: NestedRunRequest): Promise<NestedRunResult>;
  readonly subagents?: SubagentTaskPort;
  readonly shellTasks?: ShellTaskPort;
  /** Task-scoped async child question; never a user interaction or synthetic answer. */
  readonly askOrchestrator?: (question: string) => Promise<string>;
  readonly workspace: Workspace;
  readonly settings: SettingsReader;
  readonly signal: AbortSignal;
  /** Streams partial output (e.g. shell lines) while the tool runs. */
  progress(chunk: string): void;
  /** Engine-owned gate for one physical scripted leaf; preserves its raw return value. */
  executeChild?<T>(
    descriptor: { readonly toolName: string; readonly input: unknown; readonly sourceCallId: string },
    operation: () => Promise<T>,
  ): Promise<T>;
  /** Live tool interaction routed through the engine stream and durable Session answer. */
  interact?(request: ToolInteractionRequest): Promise<InteractionDecision>;
};

export type Risk = 'low' | 'medium' | 'high';

export type ApprovalRequirement =
  | { readonly kind: 'none' }
  | { readonly kind: 'ask'; readonly summary: string; readonly risk?: Risk; readonly detail?: string }
  | { readonly kind: 'deny'; readonly reason: string };

export type ToolResult = {
  /** Native root continuation control; settle this result and physical cleanup before stopping. */
  readonly stopAfterExecution?: true;
  readonly output: string;
  readonly isError: boolean;
  /** Provider-facing structured tool output, such as image parts from read_file. */
  readonly providerOutput?: Extract<Item, { readonly type: 'tool_result' }>['providerOutput'];
  /** Structured data for clients (diffs, file lists). Never sent to the model. */
  readonly display?: unknown;
};

export interface Tool<Input = unknown> {
  readonly spec: ToolSpec;
  readonly parallelSafe?: boolean | ((input: Input, ctx: ToolContext) => boolean | Promise<boolean>);
  /** Throws on invalid input; the engine reports that to the model as a tool error. */
  parse(raw: unknown): Input;
  /** Decides before execution. Pure: no side effects. */
  approval(input: Input, ctx: ToolContext): ApprovalRequirement | Promise<ApprovalRequirement>;
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolRegistry {
  get(name: string): Tool | undefined;
  /** The tools offered for one turn, after mode and settings filters. */
  available(ctx: Pick<ToolContext, 'workspace' | 'settings'>): readonly Tool[];
}
