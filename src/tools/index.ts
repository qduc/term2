/** Term2 tool context and host task capabilities over the portable harness contracts. */
import type { ModelRef, ModelError } from '../model/index.js';
import type { SettingsReader } from '../config/index.js';
import type {
  ExecutionId,
  ToolContext as HarnessToolContext,
  Tool as HarnessTool,
  ToolRegistry as HarnessToolRegistry,
} from '@qduc/agent-harness-core';
export type {
  NestedRunBudget,
  NestedRunOutcome,
  NestedRunRequest,
  NestedRunResult,
  ExecutionId,
  InteractionRequestId,
  InteractionDecision,
  ToolInteractionRequest,
  Risk,
  ApprovalRequirement,
  ToolResult,
} from '@qduc/agent-harness-core';

export type Workspace = {
  readonly root: string;
  readonly access: 'read' | 'read_write';
  /** 'local' or a remote target such as an SSH host id. */
  readonly target: string;
};

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
/** Session-owned shell process lease. Admission precedes run; settlement includes cleanup. */
export type ShellTaskPort = {
  start<T>(request: ShellTaskStart<T>): {
    readonly id: string;
    readonly startedAt: number;
    readonly settled: Promise<ShellTaskState>;
    readonly foreground: Promise<{ readonly kind: 'result'; readonly value: T } | { readonly kind: 'background' }>;
    /** Async delivery retains this admitted launch's provenance, not the caller's current execution. */
    notify(key: string, text: string): boolean;
  };
  get(id: string): ShellTaskState | undefined;
  list(): readonly ShellTaskState[];
  cancel(id: string): boolean;
  output(id: string, chunk: string): boolean;
  notify(id: string, key: string, text: string): boolean;
};
export type ShellTaskStart<T> = {
  /** Foreground invocation cancellation, including script deadlines; detached on adoption. */
  readonly parentSignal?: AbortSignal;
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

export type Term2ToolAppContext = {
  readonly workspace: Workspace;
  readonly settings: SettingsReader;
  readonly subagents?: SubagentTaskPort;
  readonly shellTasks?: ShellTaskPort;
  readonly askOrchestrator?: (question: string) => Promise<string>;
};
export type ToolContextSeed = Pick<Term2ToolAppContext, 'workspace' | 'settings'>;
export type ToolContext<AppCtx = Term2ToolAppContext> = HarnessToolContext<AppCtx>;
export type Tool<Input = unknown, AppCtx = Term2ToolAppContext> = HarnessTool<Input, AppCtx>;
export type ToolRegistry<AppCtx = Term2ToolAppContext> = HarnessToolRegistry<AppCtx>;
