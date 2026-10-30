/**
 * tools/ — what the agent can do.
 *
 * Each tool carries its schema, its own approval policy and its execute
 * function. Tools know nothing about UIs, sessions or transports.
 * Depends on: model (ToolSpec), config.
 */

import type { ToolSpec } from '../model/index.js';
import type { SettingsReader } from '../config/index.js';

export type Workspace = {
  readonly root: string;
  readonly access: 'read' | 'read_write';
  /** 'local' or a remote target such as an SSH host id. */
  readonly target: string;
};

export type ToolContext = {
  readonly workspace: Workspace;
  readonly settings: SettingsReader;
  readonly signal: AbortSignal;
  /** Streams partial output (e.g. shell lines) while the tool runs. */
  progress(chunk: string): void;
};

export type Risk = 'low' | 'medium' | 'high';

export type ApprovalRequirement =
  | { readonly kind: 'none' }
  | { readonly kind: 'ask'; readonly summary: string; readonly risk: Risk; readonly detail?: string }
  | { readonly kind: 'deny'; readonly reason: string };

export type ToolResult = {
  readonly output: string;
  readonly isError: boolean;
  /** Structured data for clients (diffs, file lists). Never sent to the model. */
  readonly display?: unknown;
};

export interface Tool<Input = unknown> {
  readonly spec: ToolSpec;
  /** Throws on invalid input; the engine reports that to the model as a tool error. */
  parse(raw: unknown): Input;
  /** Decides before execution. Pure: no side effects. */
  approval(input: Input, ctx: ToolContext): ApprovalRequirement;
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
  /** Safe to re-run after a crash between start and result. Drives resume behaviour. */
  readonly idempotent: boolean;
}

export interface ToolRegistry {
  get(name: string): Tool | undefined;
  /** The tools offered for one turn, after mode and settings filters. */
  available(ctx: Pick<ToolContext, 'workspace' | 'settings'>): readonly Tool[];
}
