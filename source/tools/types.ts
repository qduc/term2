import type { z, ZodTypeAny } from 'zod';
import type { ApprovalPresentationCapability } from './tool-capabilities.js';
import type { DeniedReadMetadata, PostExecuteDecision } from '../contracts/conversation.js';

export interface CommandMessage {
  id: string;
  sender: 'command';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  command: string;
  output: string;
  success?: boolean;
  failureReason?: string;
  isApprovalRejection?: boolean;
  autoApprovedByLlm?: boolean;
  toolName?: string;
  toolArgs?: unknown;
  callId?: string;
}

export type FormatCommandMessage = (
  item: import('./format-helpers.js').ToolResultItem,
  index: number,
  toolCallArgumentsById: Map<string, unknown>,
) => CommandMessage[];

/** Application-owned policy invoked before a tool result returns to the SDK. */
export interface PostExecutePolicyContext<Params = unknown> {
  /** Parameters normalized against this tool's schema. */
  params: Params;
  /** The result returned by the original tool execution. */
  result: unknown;
  /** SDK execution details, including `toolCall.callId` when the runner supplies it. */
  details: unknown;
  /** Re-runs the original execution with the same params, context, and SDK details. */
  executeAgain: () => Promise<unknown>;
}

export type PostExecutePolicy<Params = unknown> = (
  context: PostExecutePolicyContext<Params>,
) => Promise<unknown> | unknown;

/** Opt-in descriptor for the session-owned post-execute approval seam. */
export interface PostExecutePauseDescriptor<Params = unknown> {
  describe(
    params: Params,
    result: unknown,
    details: unknown,
  ): { toolName: string; argumentsText: string; deniedRead?: DeniedReadMetadata } | null;
  resolve?(context: PostExecutePolicyContext<Params>, decision: PostExecuteDecision): Promise<unknown> | unknown;
}

/** Construction-time capability. Root tools only in this slice; nested tools do not inherit it. */
export interface PostExecutePauseCapability {
  forTool<TSchema extends ZodTypeAny>(
    definition: SchemaToolDefinition<TSchema>,
  ): PostExecutePolicy<z.infer<TSchema>> | undefined;
}

/**
 * Schema-derived form of the tool contract (the migration target). Executor and
 * approval parameters derive from the Zod schema via `z.infer`, so the schema is
 * the single source of truth; executor results are erased to `unknown` — never
 * `any`. Consumers that need a concrete result narrow explicitly.
 *
 * Migrated factories can use this form directly (`SchemaToolDefinition<typeof
 * schema>`) or the {@link ToolDefinition} conditional alias, which resolves to
 * this form for concrete schema type arguments.
 */
export interface SchemaToolDefinition<TSchema extends ZodTypeAny> {
  name: string;
  description: string;
  parameters: TSchema;
  argumentParsing?: 'repair' | 'strict';
  approvalPresentation?: ApprovalPresentationCapability;
  needsApproval: (params: z.infer<TSchema>, context?: unknown) => Promise<boolean> | boolean;
  execute: (
    params: z.infer<TSchema>,
    context?: unknown,
    details?: unknown,
  ) => Promise<unknown> | unknown;
  postExecute?: PostExecutePolicy<z.infer<TSchema>>;
  /** Selectively opt this root definition into session-owned post-execute approval. */
  postExecutePause?: PostExecutePauseDescriptor<z.infer<TSchema>>;
  /**
   * Formats tool execution results into command messages for display.
   * @param item - The raw tool execution item from the conversation
   * @param index - The index of this item in the items array
   * @param toolCallArgumentsById - Map of call IDs to their arguments for fallback lookup
   * @returns Array of CommandMessage objects to display to the user
   */
  formatCommandMessage: FormatCommandMessage;
}

/**
 * Pre-migration form of the tool contract, kept byte-for-byte compatible with
 * the historical `ToolDefinition<Params>`: the type argument is the executor
 * parameter type (unrelated to the schema), `parameters` stays a `ZodObject`,
 * and results keep the historical `any`. Migrating a factory means switching
 * its type argument from `ToolDefinition<SomeParams>` to
 * `ToolDefinition<typeof someSchema>`, which moves it onto
 * {@link SchemaToolDefinition} and tightens results to `unknown`.
 */
interface LegacyToolDefinition<Params = any> {
  name: string;
  description: string;
  parameters: ZodObjectLegacy;
  argumentParsing?: 'repair' | 'strict';
  approvalPresentation?: ApprovalPresentationCapability;
  needsApproval: (params: Params, context?: unknown) => Promise<boolean> | boolean;
  execute: (params: Params, context?: unknown, details?: unknown) => Promise<any> | any;
  postExecute?: PostExecutePolicy<Params>;
  /** Selectively opt this root definition into session-owned post-execute approval. */
  postExecutePause?: PostExecutePauseDescriptor<Params>;
  formatCommandMessage: FormatCommandMessage;
}

/** The historical `ZodObject<any, any>` parameter-schema shape. */
type ZodObjectLegacy = z.ZodObject<any, any>;

/**
 * The application-owned tool contract.
 *
 * `TParams` is either the tool's Zod parameter schema (the migration target —
 * executor and approval parameters derive from it via `z.infer`) or a plain
 * parameter-object type (the pre-migration form). A bare `ToolDefinition` keeps
 * the historical permissive `any`/`any` erasure for factories that have not
 * been migrated yet. Migrated (schema-typed) definitions erase executor results
 * to `unknown`; the erased registry {@link AnyToolDefinition} erases both
 * deliberately.
 */
export type ToolDefinition<TParams = any> = TParams extends ZodTypeAny
  ? SchemaToolDefinition<TParams>
  : LegacyToolDefinition<TParams>;

/**
 * Explicitly erased entry for heterogeneous tool collections. Executor *params*
 * are deliberately erased to `any` — the documented escape that lets
 * definitions with differing schemas coexist in one list without variance
 * casts — while executor *results* stay `unknown`. Prefer this over a bare
 * `ToolDefinition` wherever tools with differing schemas are collected.
 */
export interface AnyToolDefinition {
  name: string;
  description: string;
  parameters: ZodTypeAny;
  argumentParsing?: 'repair' | 'strict';
  approvalPresentation?: ApprovalPresentationCapability;
  needsApproval: (params: any, context?: unknown) => Promise<boolean> | boolean;
  execute: (params: any, context?: unknown, details?: unknown) => Promise<unknown> | unknown;
  postExecute?: PostExecutePolicy<any>;
  postExecutePause?: PostExecutePauseDescriptor<any>;
  formatCommandMessage: FormatCommandMessage;
}

/** Heterogeneous tool registry: definitions with differing schemas in one list. */
export type ToolRegistry = readonly AnyToolDefinition[];
