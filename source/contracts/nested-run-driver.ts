import type { JsonSchemaDefinition } from './model-types.js';
import type { RequestSnapshot, ToolRegistry } from '../tools/types.js';
import type { ProviderInput } from './provider-input.js';
import type { StreamedModelTurn } from './streamed-model-turn.js';
import type { ContinuationHandle } from './continuation-handle.js';
import type { ApplicationRunEvent } from './application-stream.js';
import type { RunTerminationCause } from './run-termination.js';
import type { ProviderDefinition } from '../providers/registry.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../services/service-interfaces.js';
import type { ModelInfo } from '../services/model-service.js';

/** Optional source composition binding for child provider metadata and scoped transports. */
export interface NestedModelBinding {
  hasUnsettledReads(): boolean;
  trackDetachedRead(operation: Promise<unknown>): void;
  acquireHelper(
    ref: { readonly provider: string; readonly model: string },
    deps: {
      readonly settingsService: ISettingsService;
      readonly loggingService: ILoggingService;
      readonly sessionContextService?: ISessionContextService;
    },
  ): { readonly original: StreamedModelTurn | Promise<StreamedModelTurn>; release(): Promise<void> };
  providerDefinition(providerId: string): ProviderDefinition;
  scopedModel(
    ref: { readonly provider: string; readonly model: string },
    deps: {
      readonly settingsService: ISettingsService;
      readonly loggingService: ILoggingService;
      readonly sessionContextService?: ISessionContextService;
    },
  ): StreamedModelTurn | Promise<StreamedModelTurn>;
  fetchModels(
    providerId: string,
    deps: {
      readonly settingsService: ISettingsService;
      readonly loggingService: ILoggingService;
      readonly signal?: AbortSignal;
    },
  ): Promise<readonly ModelInfo[]>;
  modelDefaultReasoningLevel(
    providerId: string,
    modelId: string,
    settingsService: ISettingsService,
  ): string | undefined;
  providerDefaultReasoningLevel(providerId: string): string | undefined;
}

export interface AgentModelSettings {
  temperature?: number;
  reasoning?: { effort?: string; summary?: string };
  maxTokens?: number;
  maxRequestInputTokens?: number | null;
  /** Hard per-request stream-output budget across text, reasoning, and tool arguments. */
  maxStreamOutputChars?: number;
  /** Optional total wall-clock ceiling for each provider request; 0 disables it. Opt-in backstop. */
  maxModelRequestDurationMs?: number;
  /** Provider-neutral inactivity window: abort if no streamed delta arrives within this many ms; 0 disables it. */
  maxModelStreamIdleMs?: number;
  retry?: { maxRetries?: number };
  providerData?: Record<string, unknown>;
  codex?: { promptCacheKey?: string; include?: readonly string[] };
  [key: string]: unknown;
}

/** The application-owned agent shape consumed by the replacement run loop. */
export interface ApplicationAgent {
  readonly name: string;
  readonly instructions: string;
  /** Resolve session-dynamic instruction context once at each provider request boundary. */
  readonly resolveInstructionsForRequest?: () => string;
  /**
   * Capture the session state rendered into a request, at that same request
   * boundary. The response's tool calls execute with it (see `RequestSnapshot`).
   */
  readonly resolveRequestSnapshot?: () => RequestSnapshot;
  readonly model: string;
  readonly memoryContextEnabled?: boolean;
  modelSettings?: AgentModelSettings;
  defaultRunOptions?: any;
  outputType?: JsonSchemaDefinition | 'text';
  readonly tools: ToolRegistry;
}

export interface RunBudgetPolicy {
  readonly maxUsdMicros: number;
  readonly maxUnpricedTokens: number;
  readonly maxActiveTimeMs: number;
  readonly warningHeadroomUsdMicros: number;
  readonly warningHeadroomUnpricedTokens: number;
  readonly warningHeadroomActiveTimeMs: number;
  readonly softHeadroomUsdMicros: number;
  readonly softHeadroomUnpricedTokens: number;
  readonly softHeadroomActiveTimeMs: number;
  readonly turnBackstop: number;
  readonly extensionPercent: number;
  readonly maxParentExtensions: number;
  readonly identicalToolCallThreshold: number;
  /**
   * What a non-soft stage does.
   *
   * `contain` keeps warning/stall advisory and parks at exhaustion. `warn`
   * remains an explicit advisory opt-out; `pause` also parks on warning/stall.
   */
  readonly escalation: 'contain' | 'warn' | 'pause' | 'disabled';
}

export type RunBudgetStage = 'soft' | 'warning' | 'critical';
export type RunBudgetDimension = 'usd' | 'unpriced_tokens' | 'active_time' | 'turns';

export interface RunBudgetEvidence {
  readonly dimension: RunBudgetDimension;
  readonly used: number;
  readonly limit: number;
  readonly headroom: number;
}

export type RunBudgetEvent =
  | { readonly type: 'budget_stage'; readonly stage: RunBudgetStage; readonly evidence: RunBudgetEvidence }
  | {
      readonly type: 'tool_stall';
      readonly toolName: string;
      readonly argumentsText: string;
      readonly count: number;
      readonly threshold: number;
    };

export interface NestedApprovalLedger {
  approveTool(item: { toolName: string; callId: string }, options?: { alwaysApprove?: boolean }): void;
  rejectTool(item: { toolName: string; callId: string }, options?: { alwaysReject?: boolean; message?: string }): void;
  blanketDecision(toolName: string): boolean | undefined;
  blanketRejectionMessage(toolName: string): string | undefined;
  snapshot(): Readonly<
    Record<string, { approved: boolean | string[]; rejected: boolean | string[]; stickyRejectMessage?: string }>
  >;
}

export interface NestedRunStream extends AsyncIterable<ApplicationRunEvent> {
  completed: Promise<unknown>;
  history: unknown[];
  newItems: unknown[];
  output: unknown[];
  finalOutput?: string;
  lastResponseId?: string | null;
  interruptions?: unknown[];
  state?: ContinuationHandle;
  cancelled?: boolean;
  runUsage?: unknown;
  runCostRecords?: unknown[];
  terminalCause?: RunTerminationCause;
}
export interface NestedRunOptions {
  readonly signal?: AbortSignal;
  readonly context?: unknown;
  readonly approvals?: NestedApprovalLedger;
  readonly providerId?: string;
  readonly supportsConversationChaining?: boolean;
  readonly previousResponseId?: string | null;
  readonly maxTurns?: number;
  readonly runBudget?: RunBudgetPolicy;
  readonly wrapUpOnCriticalRunBudget?: boolean;
  readonly onRunBudgetEvent?: (event: RunBudgetEvent) => void;
}
export interface NestedRunDriver {
  startStream(agent: ApplicationAgent, input: ProviderInput, options?: NestedRunOptions): NestedRunStream;
  continueRunStream(handle: ContinuationHandle, options?: NestedRunOptions): NestedRunStream;
  abort(): void;
}
export type NestedRunDriverFactory = (deps: {
  readonly resolveModel: (model: string) => StreamedModelTurn | Promise<StreamedModelTurn>;
  readonly resolveMaxParallelToolCalls?: () => number | undefined;
}) => NestedRunDriver;
