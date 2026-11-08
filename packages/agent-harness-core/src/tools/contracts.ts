/** Portable tool contracts. Application capabilities live in ToolContext.app. */
import type { Item, ToolSpec, ModelRef, ModelError, ReasoningEffort } from '../model/index.js';

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

export type NestedRunRequest = {
  /** Original caller task input, preserved separately from resolved instructions/history. */
  readonly input?: string;
  readonly mode?: 'foreground' | 'background';
  /** A continuation keeps its settled run's ID, as legacy's async registry does. */
  readonly runId?: string;
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
  /** Host-formatted legacy result (evidence, final text) that a background completion notice carries. */
  readonly report?: string;
};

export type ExecutionId = string & { readonly __brand: 'ExecutionId' };
export type InteractionRequestId = string & { readonly __brand: 'InteractionRequestId' };
export type InteractionDecision = (
  | {
      readonly kind: 'allow';
      /** One of the request's own `grants`: the session scope the user chose (legacy's grant answers). */
      readonly grant?: string;
    }
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
  /** Scoped grants this approval offers besides plain allow; an allow may carry only one of these. */
  readonly grants?: readonly string[];
};

export type ToolContext<AppCtx = unknown> = {
  readonly app: AppCtx;
  runNested(request: NestedRunRequest): Promise<NestedRunResult>;
  readonly signal: AbortSignal;
  progress(chunk: string): void;
  executeChild?<T>(
    descriptor: { readonly toolName: string; readonly input: unknown; readonly sourceCallId: string },
    operation: () => Promise<T>,
  ): Promise<T>;
  interact?(request: ToolInteractionRequest): Promise<InteractionDecision>;
  readonly approvalGrant?: string;
};

export type Risk = 'low' | 'medium' | 'high';

export type ApprovalRequirement =
  /** `batched`: legacy still counts the call in its approval batch, decided by policy without a prompt. */
  | { readonly kind: 'none'; readonly batched?: true }
  /** The call's own question, asked with the response's approvals before any of them runs. */
  | { readonly kind: 'question'; readonly request: ToolInteractionRequest }
  | {
      readonly kind: 'ask';
      readonly summary: string;
      readonly risk?: Risk;
      readonly detail?: string;
      readonly grants?: readonly string[];
    }
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

export interface Tool<Input = unknown, AppCtx = unknown> {
  readonly spec: ToolSpec;
  readonly parallelSafe?: boolean | ((input: Input, ctx: ToolContext<AppCtx>) => boolean | Promise<boolean>);
  /** Throws on invalid input; the engine reports that to the model as a tool error. */
  parse(raw: unknown): Input;
  /** Decides before execution. Pure: no side effects. */
  approval(input: Input, ctx: ToolContext<AppCtx>): ApprovalRequirement | Promise<ApprovalRequirement>;
  execute(input: Input, ctx: ToolContext<AppCtx>): Promise<ToolResult>;
}

export interface ToolRegistry<AppCtx = unknown> {
  get(name: string): Tool<unknown, AppCtx> | undefined;
  /** The tools offered for one turn, after mode and settings filters. */
  available(ctx: AppCtx): readonly Tool<unknown, AppCtx>[];
}
