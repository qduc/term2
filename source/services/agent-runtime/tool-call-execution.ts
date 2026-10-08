import type { StreamedModelTurnEvent } from '../../contracts/streamed-model-turn.js';
import type {
  AnyToolDefinition,
  ToolExecutionLifecycleContext,
  ToolExecutionLifecyclePort,
  ToolRegistry,
} from '../../tools/types.js';
import { isCancellationError, isHarnessInvariantError } from '../../lib/harness-invariant-error.js';
import { describeError } from '../../utils/error-helpers.js';
import { normalizeToolParameters } from '../../lib/tool-invoke.js';
import { ApprovalLedger, type ToolInvocationContext } from './tool-invocation-context.js';

export type ToolPlanEntry = {
  readonly event: Extract<StreamedModelTurnEvent, { type: 'tool_call' }>;
  readonly definition?: AnyToolDefinition;
  params?: unknown;
  parallelSafe: boolean;
  status: 'ready' | 'approval_pending' | 'completed';
  output?: string;
  result?: unknown;
};

export type PendingToolApproval = {
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsText: string;
  readonly interruption: Record<string, unknown>;
  readonly definition: AnyToolDefinition;
  readonly params: unknown;
  readonly plan: ToolPlanEntry;
};

export interface ToolCallExecutionDependencies {
  readonly toolLifecycle?: ToolExecutionLifecyclePort;
  readonly getOnToolDispatch?: () => ((callId: string) => void) | undefined;
  readonly resolveMaxParallelToolCalls?: () => number | undefined;
  readonly isMaxTurnsExceeded?: (error: unknown) => boolean;
  readonly logDiagnostic?: (
    message: string,
    meta: Record<string, unknown>,
    options?: { severity?: 'debug' | 'info'; eventType?: string },
  ) => void;
}

export interface ToolCallExecutionContext {
  readonly tools: ToolRegistry;
  readonly approvals: ApprovalLedger;
  readonly toolContext: ToolInvocationContext;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly hookScope?: ToolExecutionLifecycleContext['scope'];
  readonly onCall: (event: Extract<StreamedModelTurnEvent, { type: 'tool_call' }>) => void;
  readonly onDispatch: (entry: ToolPlanEntry) => void;
  readonly onToolStall: (input: { name: string; argumentsText: string; effect: AnyToolDefinition['effect'] }) => void;
  readonly onResult: (entry: ToolPlanEntry, result: unknown) => void;
}

/** Owns the planned calls and their approval/execution/settlement lifecycle for one run. */
export class ToolCallExecution {
  #plan: ToolPlanEntry[] | undefined;
  #pendingApprovals: PendingToolApproval[] = [];
  #attempts = new Map<string, number>();
  #terminateAfterExecution = false;
  readonly #deps: ToolCallExecutionDependencies;

  constructor(deps: ToolCallExecutionDependencies) {
    this.#deps = deps;
  }

  get hasPlan(): boolean {
    return Boolean(this.#plan);
  }

  get pendingApprovals(): readonly PendingToolApproval[] {
    return this.#pendingApprovals;
  }

  get terminateAfterExecution(): boolean {
    return this.#terminateAfterExecution;
  }

  async plan(
    events: readonly Extract<StreamedModelTurnEvent, { type: 'tool_call' }>[],
    context: ToolCallExecutionContext,
  ): Promise<void> {
    const plan = events.map((event): ToolPlanEntry => {
      context.onCall(event);
      return {
        event,
        definition: context.tools.find((tool) => tool.name === event.name),
        parallelSafe: false,
        status: 'ready',
      };
    });
    this.#plan = plan;

    for (const entry of plan) {
      const { event, definition } = entry;
      if (!definition) {
        entry.output = `Unknown tool: ${event.name}`;
        continue;
      }
      try {
        const parsedArguments = definition.parseModelArguments
          ? definition.parseModelArguments(event.arguments)
          : parseArguments(event.arguments);
        entry.params = normalizeToolParameters(parsedArguments, definition.parameters);
      } catch (error) {
        entry.output = `Error: Invalid patch: ${describeError(error)}`;
        continue;
      }
      context.onToolStall({ name: event.name, argumentsText: event.arguments, effect: definition.effect });
      // Only blanket decisions apply to a newly planned call. A per-call
      // approval or rejection is bound to its plan entry (resolveApproval) and
      // must never authorize a later call that reuses the same id.
      const alreadyDecided = context.approvals.blanketDecision(event.name);
      if (alreadyDecided === false) {
        entry.output = context.approvals.blanketRejectionMessage(event.name) ?? 'Tool execution was not approved.';
        continue;
      }
      if (alreadyDecided !== true && (await definition.needsApproval(entry.params, context.toolContext))) {
        entry.status = 'approval_pending';
        this.#pendingApprovals.push({
          callId: event.id,
          toolName: event.name,
          argumentsText: event.arguments,
          interruption: {
            type: 'tool_approval_item',
            rawItem: { type: 'function_call', callId: event.id, name: event.name, arguments: event.arguments },
            callId: event.id,
            name: event.name,
            arguments: event.arguments,
          },
          definition,
          params: entry.params,
          plan: entry,
        });
        continue;
      }
      entry.parallelSafe = await isParallelSafe(definition, entry.params, context.toolContext);
    }
    this.#logEligibility(plan);
  }

  /**
   * Settle exactly the pending call the decision was made for. The interruption
   * object the caller answered identifies it; call ids are not unique (a
   * provider may give several calls in one response the same id), so the id is
   * only the fallback for a caller that answers with a copy of the interruption.
   */
  resolveApproval(
    target: { callId: string | undefined; interruption?: unknown },
    decision: 'approved' | 'rejected',
    message: string | undefined,
    approvals: ApprovalLedger,
  ): void {
    const { callId, interruption } = target;
    const byIdentity =
      interruption === undefined
        ? -1
        : this.#pendingApprovals.findIndex((pending) => pending.interruption === interruption);
    const selectedIndex =
      byIdentity >= 0 || !callId
        ? byIdentity
        : this.#pendingApprovals.findIndex((pending) => pending.callId === callId);
    if (callId && selectedIndex < 0)
      throw new Error(`Approval decision references unknown pending tool call: ${callId}`);
    const pendingIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const pending = this.#pendingApprovals[pendingIndex];
    if (!pending) throw new Error('Approval decision has no pending tool call');
    const approved = decision === 'approved';
    if (approved) approvals.approveTool({ toolName: pending.toolName, callId: pending.callId });
    else approvals.rejectTool({ toolName: pending.toolName, callId: pending.callId }, { message });
    pending.plan.status = 'ready';
    if (!approved) pending.plan.output = message ?? 'rejected';
    this.#pendingApprovals.splice(pendingIndex, 1);
  }

  async settle(context: ToolCallExecutionContext): Promise<void> {
    const plan = this.#plan;
    if (!plan) return;
    const maxParallelToolCalls = Math.max(
      1,
      Math.floor(this.#deps.resolveMaxParallelToolCalls?.() ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS),
    );
    while (true) {
      const firstPending = plan.find((entry) => entry.status !== 'completed');
      if (!firstPending) {
        this.#plan = undefined;
        return;
      }
      if (firstPending.status === 'approval_pending') return;
      const group: ToolPlanEntry[] = [];
      for (const entry of plan) {
        if (entry.status === 'completed') continue;
        if (entry.status === 'approval_pending') break;
        if (group.length > 0 && (!entry.parallelSafe || !group[0].parallelSafe || group.length >= maxParallelToolCalls))
          break;
        group.push(entry);
        if (!entry.parallelSafe) break;
      }
      const batchId = `tool-batch-${++nextToolBatchSeq}`;
      this.#log(
        'tool batch dispatched',
        {
          batchId,
          callIds: group.map((entry) => entry.event.id),
          parallel: group.length > 1,
          maxParallelToolCalls,
          dispatchOrder: group.map((entry) => entry.event.id),
        },
        'tool.batch.dispatched',
      );
      for (const entry of group) context.onDispatch(entry);
      const results =
        group.length > 1
          ? await Promise.allSettled(group.map((entry) => this.#invoke(entry, context)))
          : [{ status: 'fulfilled' as const, value: await this.#invoke(group[0], context) }];
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      for (const [index, result] of results.entries()) {
        const value = (result as PromiseFulfilledResult<unknown>).value;
        group[index].result = value;
        context.onResult(group[index], value);
      }
      this.#log(
        'tool batch settled',
        {
          batchId,
          callIds: group.map((entry) => entry.event.id),
          settlementOrder: group.map((entry) => entry.event.id),
        },
        'tool.batch.settled',
      );
      if (group.some((entry) => shouldTerminateAfterExecution(entry.definition, entry.result))) {
        this.#terminateAfterExecution = true;
        this.#plan = undefined;
        return;
      }
    }
  }

  #logEligibility(plan: readonly ToolPlanEntry[]): void {
    this.#deps.logDiagnostic?.(
      'tool parallel eligibility',
      {
        decisions: plan.map((entry) => ({
          callId: entry.event.id,
          toolName: entry.event.name,
          parallelSafe: entry.parallelSafe,
          approvalPending: entry.status === 'approval_pending',
        })),
      },
      { severity: 'debug', eventType: 'tool.parallel.eligibility' },
    );
  }

  #log(message: string, meta: Record<string, unknown>, eventType: string): void {
    this.#deps.logDiagnostic?.(message, meta, { severity: 'debug', eventType });
  }

  async #invoke(entry: ToolPlanEntry, context: ToolCallExecutionContext): Promise<unknown> {
    entry.status = 'completed';
    if (entry.output !== undefined) return entry.output;
    const definition = entry.definition!;
    const callId = entry.event.id;
    const startedAt = Date.now();
    const attempt = (this.#attempts.get(callId) ?? 0) + 1;
    this.#attempts.set(callId, attempt);
    const lifecycleContext: ToolExecutionLifecycleContext = {
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.turnId ? { turnId: context.turnId } : {}),
      toolCallId: callId,
      toolName: definition.name,
      normalizedArguments: entry.params,
      attempt,
      scope: context.hookScope ?? 'root',
    };
    this.#deps.getOnToolDispatch?.()?.(callId);
    await this.#notify(() => this.#deps.toolLifecycle?.before(lifecycleContext));
    try {
      const result = await definition.execute(entry.params, context.toolContext, { toolCall: { callId } });
      await this.#notify(() => this.#deps.toolLifecycle?.after(lifecycleContext, result, Date.now() - startedAt));
      return result;
    } catch (error) {
      const maxTurns = this.#deps.isMaxTurnsExceeded?.(error) ?? false;
      if (isCancellationError(error) || isHarnessInvariantError(error) || maxTurns) {
        await this.#notify(() =>
          this.#deps.toolLifecycle?.error(lifecycleContext, error, Date.now() - startedAt, false),
        );
        throw error;
      }
      const result = `Error: ${describeError(error)}`;
      await this.#notify(() => this.#deps.toolLifecycle?.error(lifecycleContext, error, Date.now() - startedAt, true));
      return result;
    }
  }

  async #notify(operation: (() => void | Promise<void>) | undefined): Promise<void> {
    if (!operation) return;
    try {
      await operation();
    } catch {
      // Lifecycle observers are passive and cannot change tool execution.
    }
  }
}

const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 3;
let nextToolBatchSeq = 0;

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function isParallelSafe(
  definition: AnyToolDefinition,
  params: unknown,
  context: ToolInvocationContext,
): Promise<boolean> {
  if (typeof definition.parallelSafe === 'function') {
    try {
      return await definition.parallelSafe(params as never, context);
    } catch {
      return false;
    }
  }
  return definition.parallelSafe === true;
}

function shouldTerminateAfterExecution(definition: AnyToolDefinition | undefined, result: unknown): boolean {
  const policy = definition?.terminateAfterExecution;
  if (typeof policy === 'boolean') return policy;
  if (!policy) return false;
  try {
    return policy(result);
  } catch {
    return false;
  }
}
