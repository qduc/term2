import type { z, ZodTypeAny } from 'zod';
import type { ApprovalPresentationCapability } from './tool-capabilities.js';
import type { DeniedReadMetadata, PostExecuteDecision } from '../contracts/conversation.js';
import type { Term2HookScope } from '../services/hooks/hook-contracts.js';
import type { StreamedModelCustomToolFormat } from '../contracts/streamed-model-turn.js';

/**
 * The one physical tool-execution seam.  It is observational: callbacks do
 * not return a decision and failures must never change tool behavior.
 */
export interface ToolExecutionLifecycleContext {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly normalizedArguments: unknown;
  readonly attempt: number;
  readonly scope: Term2HookScope;
}

export interface ToolExecutionLifecyclePort {
  before(context: ToolExecutionLifecycleContext): void | Promise<void>;
  after(context: ToolExecutionLifecycleContext, result: unknown, duration: number): void | Promise<void>;
  error(
    context: ToolExecutionLifecycleContext,
    error: unknown,
    duration: number,
    convertedToModelResult: boolean,
  ): void | Promise<void>;
}

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
  /** Explicit erased-registry boundary used while assembling heterogeneous tools. */
  forTool(definition: AnyToolDefinition): PostExecutePolicy<unknown> | undefined;
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
  /** Opt-in capability for independent, auto-approved calls in one model response. */
  parallelSafe?: boolean | ((params: z.infer<TSchema>, context?: unknown) => Promise<boolean> | boolean);
  /** Declares a successful call as an observable mutation for stall detection. */
  effect?: 'mutating';
  /** Result is already serialized and bounded; generic string trimming would corrupt its contract. */
  preserveSerializedOutput?: boolean;
  /** End the run after execution without sending this tool result to the model. */
  terminateAfterExecution?: boolean | ((result: unknown) => boolean);
  /** Optional provider-facing schema when a strict transport cannot express the runtime contract. */
  strictParameters?: ZodTypeAny;
  argumentParsing?: 'repair' | 'strict';
  /** Provider-facing freeform tool declaration for transports that support it. */
  modelTool?: {
    readonly type: 'custom';
    readonly format: StreamedModelCustomToolFormat;
  };
  /** Converts a provider's raw freeform tool input into the executor's params. */
  parseModelArguments?: (input: string) => unknown;
  approvalPresentation?: ApprovalPresentationCapability;
  needsApproval: (params: z.infer<TSchema>, context?: unknown) => Promise<boolean> | boolean;
  execute: (params: z.infer<TSchema>, context?: unknown, details?: unknown) => Promise<unknown> | unknown;
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

/** The JSON-schema form substituted for Zod schemas on providers' strict-tool path. */
export type JsonSchemaObject = Record<string, unknown>;

/** A tool schema before or after strict JSON-schema substitution. */
export type ToolParameterSchema = ZodTypeAny | JsonSchemaObject;

/** Runtime discriminator for the executable Zod side of {@link ToolParameterSchema}. */
export function isZodToolParameterSchema(schema: unknown): schema is ZodTypeAny {
  return typeof (schema as { safeParse?: unknown } | null)?.safeParse === 'function';
}

/**
 * The application-owned tool contract. A schema is always the source of truth:
 * executor and approval parameters derive from it and results are `unknown`.
 */
export type ToolDefinition<TSchema extends ZodTypeAny = ZodTypeAny> = SchemaToolDefinition<TSchema>;

/**
 * Explicitly erased entry for heterogeneous registries. The union honestly
 * represents strict-provider JSON-schema substitution. Its method signatures
 * are intentionally bivariant so definitions with different schema-derived
 * parameter types can coexist; callers must normalize against `parameters`
 * before invoking either callback.
 */
export interface AnyToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  /** Opt-in capability for independent, auto-approved calls in one model response. */
  /** `never` keeps heterogeneous schema-derived predicates assignable at the erased boundary. */
  parallelSafe?: boolean | ((params: never, context?: unknown) => Promise<boolean> | boolean);
  /** Declares a successful call as an observable mutation for stall detection. */
  effect?: 'mutating';
  /** Result is already serialized and bounded; generic string trimming would corrupt its contract. */
  preserveSerializedOutput?: boolean;
  /** End the run after execution without sending this tool result to the model. */
  terminateAfterExecution?: boolean | ((result: unknown) => boolean);
  strictParameters?: ZodTypeAny;
  argumentParsing?: 'repair' | 'strict';
  modelTool?: {
    readonly type: 'custom';
    readonly format: StreamedModelCustomToolFormat;
  };
  parseModelArguments?: (input: string) => unknown;
  approvalPresentation?: ApprovalPresentationCapability;
  needsApproval(params: unknown, context?: unknown): Promise<boolean> | boolean;
  execute(params: unknown, context?: unknown, details?: unknown): Promise<unknown> | unknown;
  /** Internal marker used at the run-loop boundary for synthetic interceptor results. */
  isInterceptorResult?(result: unknown): boolean;
  postExecute?(context: PostExecutePolicyContext<unknown>): Promise<unknown> | unknown;
  postExecutePause?: PostExecutePauseDescriptor<unknown>;
  formatCommandMessage: FormatCommandMessage;
}

/** Heterogeneous tool registry: definitions with differing schemas in one list. */
export type ToolRegistry = readonly AnyToolDefinition[];
