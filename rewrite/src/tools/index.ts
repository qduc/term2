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
  | { readonly kind: 'completed' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'budget_exhausted' }
  | {
      readonly kind: 'interrupted';
      readonly terminalCause?: 'goal_check_unresolved' | 'completion_verification_blocked';
    }
  | { readonly kind: 'failed'; readonly error: ModelError };

export type NestedRunRequest = {
  readonly instructions: string;
  readonly items: readonly Item[];
  readonly toolNames: readonly string[];
  readonly model: ModelRef;
  readonly reasoning?: ReasoningEffort;
  readonly budget: NestedRunBudget;
};
export type NestedRunResult = { readonly items: readonly Item[]; readonly outcome: NestedRunOutcome };

export type ToolContext = {
  runNested(request: NestedRunRequest): Promise<NestedRunResult>;
  readonly workspace: Workspace;
  readonly settings: SettingsReader;
  readonly signal: AbortSignal;
  /** Streams partial output (e.g. shell lines) while the tool runs. */
  progress(chunk: string): void;
};

export type Risk = 'low' | 'medium' | 'high';

export type ApprovalRequirement =
  | { readonly kind: 'none' }
  | { readonly kind: 'ask'; readonly summary: string; readonly risk?: Risk; readonly detail?: string }
  | { readonly kind: 'deny'; readonly reason: string };

export type ToolResult = {
  readonly output: string;
  readonly isError: boolean;
  /** Provider-facing structured tool output, such as image parts from read_file. */
  readonly providerOutput?: Extract<Item, { readonly type: 'tool_result' }>['providerOutput'];
  /** Structured data for clients (diffs, file lists). Never sent to the model. */
  readonly display?: unknown;
};

export interface Tool<Input = unknown> {
  readonly spec: ToolSpec;
  /** Throws on invalid input; the engine reports that to the model as a tool error. */
  parse(raw: unknown): Input;
  /** Decides before execution. Pure: no side effects. */
  approval(input: Input, ctx: ToolContext): ApprovalRequirement | Promise<ApprovalRequirement>;
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
  /** Safe to re-run after a crash between start and result. Drives resume behaviour. */
  readonly idempotent: boolean;
}

export interface ToolRegistry {
  get(name: string): Tool | undefined;
  /** The tools offered for one turn, after mode and settings filters. */
  available(ctx: Pick<ToolContext, 'workspace' | 'settings'>): readonly Tool[];
}
