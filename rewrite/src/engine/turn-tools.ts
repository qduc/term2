/** Turn-local tool planning, physical admission, interactions and ordered settlement. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Item, ItemId, ToolCallId } from '../model/index.js';
import type {
  ApprovalRequirement,
  ExecutionId,
  InteractionDecision,
  InteractionRequestId,
  Tool,
  ToolContext,
  ToolInteractionRequest,
  ToolResult,
} from '../tools/index.js';
import type { InteractionRequest, TurnDeps, TurnSpec } from './direct-types.js';
import { TurnEvents, cancelled } from './turn-events.js';

type CallItem = Extract<Item, { type: 'tool_call' }>;
type Execution = {
  readonly executionId: ExecutionId;
  readonly parentExecutionId?: ExecutionId;
  readonly callId: ToolCallId;
  readonly toolName: string;
  input: unknown;
  readonly children: Set<Promise<unknown>>;
  open: boolean;
  admitted: boolean;
};
export type RootCall = { readonly item: CallItem; readonly executionId: ExecutionId; readonly execution: Execution };
type Plan = {
  readonly call: RootCall;
  readonly tool?: Tool;
  readonly context?: ToolContext;
  readonly input?: unknown;
  readonly approval?: ApprovalRequirement;
  readonly parallelSafe: boolean;
  readonly result?: ToolResult;
};
type PendingInteraction = {
  readonly request: InteractionRequest;
  ready: boolean;
  resolve(decision: InteractionDecision): void;
  reject(error: Error): void;
};
type StopTarget = {
  executionId?: ExecutionId;
  readonly parentExecutionId?: ExecutionId;
  readonly sourceCallId?: string;
  readonly toolName: string;
};

export class TurnTools {
  readonly #offered: ReadonlySet<string>;
  readonly #scope = new AsyncLocalStorage<Execution>();
  readonly #interactions = new Map<InteractionRequestId, PendingInteraction>();
  readonly #running = new Set<Promise<unknown>>();
  #executionOrdinal = 0;
  #questionOrdinal = 0;
  #closed = false;
  #stop: StopTarget | undefined;

  constructor(
    readonly spec: TurnSpec,
    readonly deps: TurnDeps,
    readonly signal: AbortSignal,
    readonly events: TurnEvents,
  ) {
    this.#offered = new Set(spec.tools.map((tool) => tool.name));
  }

  get stopped(): boolean {
    return this.#stop !== undefined;
  }

  /** Provider call IDs are presentation only; even repeated IDs allocate a fresh occurrence. */
  root(item: CallItem): RootCall {
    const execution = this.#allocate(item.toolName, item.input, item.callId);
    return { item, executionId: execution.executionId, execution };
  }

  /** Plan all complete calls, then settle contiguous safe batches in provider order. */
  async run(calls: readonly RootCall[], history: Item[]): Promise<void> {
    const plans: Plan[] = [];
    for (const call of calls) plans.push(await this.#plan(call));
    let position = 0;
    const configured = this.deps.maxParallelToolCalls ?? 3;
    const width = Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 3;
    while (position < plans.length) {
      this.#check();
      const group = [plans[position++]!];
      while (
        position < plans.length &&
        group.length < width &&
        readyParallel(group[0]!) &&
        readyParallel(plans[position]!)
      ) {
        group.push(plans[position++]!);
      }
      const results = await Promise.allSettled(group.map((plan) => this.#runRoot(plan)));
      // Never publish a later result past an unresolved earlier occurrence.
      // Sibling finish audits preserve known outputs for ordered Session repair.
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') break;
        await this.#result(group[index]!.call, result.value, history);
      }
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    }
  }

  /** Only a live, durably opened request can consume a matching decision. */
  answer(id: InteractionRequestId, decision: InteractionDecision): void {
    const pending = this.#interactions.get(id);
    if (!pending?.ready || this.#closed || this.signal.aborted) return;
    if (pending.request.kind === 'approval' && decision.kind === 'answer') return;
    if (pending.request.kind === 'question' && decision.kind === 'allow') return;
    this.#interactions.delete(id);
    pending.resolve(decision);
  }

  cancel(): void {
    this.#closed = true;
    for (const pending of this.#interactions.values()) pending.reject(cancelled());
    this.#interactions.clear();
  }

  async cleanup(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
    this.#scope.disable();
  }

  async #plan(call: RootCall): Promise<Plan> {
    this.#check();
    const base = { call, parallelSafe: false };
    if (!this.#offered.has(call.item.toolName))
      return { ...base, result: errorResult(`Unknown tool: ${call.item.toolName}`) };
    const tool = this.deps.tools?.get(call.item.toolName);
    if (!tool) return { ...base, result: errorResult(`Unknown tool: ${call.item.toolName}`) };
    if (!this.deps.toolContext) return { ...base, result: errorResult('Tool execution context is unavailable') };
    const context = this.#context(call.execution);
    try {
      const input = tool.parse(call.item.input);
      call.execution.input = input;
      let parallelSafe = false;
      try {
        parallelSafe =
          typeof tool.parallelSafe === 'function'
            ? (await tool.parallelSafe(input, context)) === true
            : tool.parallelSafe === true;
      } catch {
        /* Uncertain eligibility is serial, not failed execution. */
      }
      this.#check();
      const approval = await tool.approval(input, context);
      this.#check();
      return { call, tool, context, input, approval, parallelSafe };
    } catch (error) {
      this.#check();
      return { ...base, result: errorResult(error) };
    }
  }

  async #runRoot(plan: Plan): Promise<ToolResult> {
    const execution = plan.call.execution;
    try {
      this.#check();
      if (this.stopped) return errorResult('Tool execution stopped after interaction resolution');
      if (plan.result) return plan.result;
      if (plan.approval?.kind === 'deny') return errorResult(plan.approval.reason);
      if (plan.approval?.kind === 'ask') {
        const decision = await this.#interact(execution, {
          kind: 'approval',
          toolName: execution.toolName,
          input: execution.input,
          sourceCallId: execution.callId,
          summary: plan.approval.summary,
          ...(plan.approval.detail !== undefined ? { detail: plan.approval.detail } : {}),
          ...(plan.approval.risk !== undefined ? { risk: plan.approval.risk } : {}),
        });
        if (decision.kind !== 'allow')
          return errorResult(decision.kind === 'deny' ? decision.reason ?? 'rejected' : 'rejected');
      }
      return await this.#physical(
        execution,
        async () => {
          try {
            return await plan.tool!.execute(plan.input, plan.context!);
          } catch (error) {
            return errorResult(error);
          }
        },
        (result) => result,
      );
    } finally {
      execution.open = false;
    }
  }

  async #result(call: RootCall, result: ToolResult, history: Item[]): Promise<void> {
    const item: Item = {
      type: 'tool_result',
      id: `${call.executionId}:result` as ItemId,
      callId: call.item.callId,
      output: result.output,
      isError: result.isError,
      ...(result.providerOutput !== undefined ? { providerOutput: result.providerOutput } : {}),
      ...(call.item.toolType !== undefined ? { toolType: call.item.toolType } : {}),
    };
    await this.events.publish({ type: 'item', item, executionId: call.executionId });
    history.push(item);
  }

  #context(root: Execution): ToolContext {
    const current = (): Execution => this.#scope.getStore() ?? root;
    return {
      ...this.deps.toolContext!,
      signal: this.signal,
      runNested: async () => {
        throw new Error('Nested model execution is not available on the direct M2 path');
      },
      progress: (chunk) => {
        const execution = current();
        if (this.signal.aborted || this.#closed || !execution.open || !execution.admitted) return;
        // Progress never grants execution; cancellation rejects this live-only wait.
        void this.events.publish({ type: 'tool_progress', executionId: execution.executionId, chunk }).catch(() => {});
      },
      interact: (request) => {
        const execution = current();
        this.#checkBody(execution);
        return this.#interact(execution, request);
      },
      executeChild: <T>(
        descriptor: { toolName: string; input: unknown; sourceCallId: string },
        operation: () => Promise<T>,
      ) => {
        const parent = current();
        this.#checkBody(parent);
        const execution = this.#allocate(
          descriptor.toolName,
          descriptor.input,
          descriptor.sourceCallId as ToolCallId,
          parent.executionId,
        );
        const work = this.#physical(execution, operation, childResult);
        parent.children.add(work);
        // Observe rejection even if a script abandons its returned promise.
        void work
          .finally(() => {
            execution.open = false;
            parent.children.delete(work);
          })
          .catch(() => {});
        return work;
      },
    };
  }

  #physical<T>(execution: Execution, operation: () => Promise<T>, audit: (result: T) => ToolResult): Promise<T> {
    const work = this.#invoke(execution, operation, audit);
    this.#running.add(work);
    void work.finally(() => this.#running.delete(work)).catch(() => {});
    return work;
  }

  async #invoke<T>(execution: Execution, operation: () => Promise<T>, audit: (result: T) => ToolResult): Promise<T> {
    this.#checkStart(execution);
    await this.events.publish({
      type: 'tool_start_requested',
      executionId: execution.executionId,
      ...(execution.parentExecutionId ? { parentExecutionId: execution.parentExecutionId } : {}),
      callId: execution.callId,
      toolName: execution.toolName,
      input: execution.input,
    });
    // A receipt can race cancellation or another interaction's stop decision.
    this.#checkStart(execution);
    execution.admitted = true;
    let result: ToolResult;
    let value!: T;
    let error: unknown;
    let failed = false;
    try {
      value = await this.#scope.run(execution, operation);
      result = audit(value);
    } catch (caught) {
      failed = true;
      error = caught;
      result = errorResult(caught);
    }
    execution.open = false;
    try {
      // Record the known body outcome immediately, even if descendants/siblings are slow.
      await this.events.publish({ type: 'tool_execution_finished', executionId: execution.executionId, result });
    } finally {
      // Detached descendants are still physical work owned by this execution.
      while (execution.children.size > 0) await Promise.allSettled([...execution.children]);
    }
    if (failed) throw error;
    return value;
  }

  async #interact(execution: Execution, input: ToolInteractionRequest): Promise<InteractionDecision> {
    this.#check();
    if (this.stopped) throw new Error('Tool execution stopped after interaction resolution');
    const nested =
      input.toolName !== execution.toolName ||
      (input.sourceCallId !== undefined && input.sourceCallId !== execution.callId);
    const request: InteractionRequest = {
      ...input,
      requestId: `${this.spec.turnId}:question:${++this.#questionOrdinal}` as InteractionRequestId,
      turnId: this.spec.turnId,
      ...(nested
        ? { parentExecutionId: execution.executionId }
        : {
            executionId: execution.executionId,
            ...(execution.parentExecutionId ? { parentExecutionId: execution.parentExecutionId } : {}),
          }),
    };
    const decision = new Promise<InteractionDecision>((resolve, reject) => {
      this.#interactions.set(request.requestId, { request, ready: false, resolve, reject });
    });
    void decision.catch(() => {});
    try {
      await this.events.publish({ type: 'interaction_required', request }, () => {
        const pending = this.#interactions.get(request.requestId);
        if (pending) pending.ready = true;
      });
      const answer = await decision;
      this.#check();
      if (answer.stopAfterApprovalResolution || (request.kind === 'question' && answer.kind === 'deny')) {
        this.#stop ??= nested
          ? { parentExecutionId: execution.executionId, toolName: input.toolName, sourceCallId: input.sourceCallId }
          : { executionId: execution.executionId, toolName: input.toolName };
      }
      return answer;
    } finally {
      this.#interactions.delete(request.requestId);
    }
  }

  #allocate(toolName: string, input: unknown, callId: ToolCallId, parentExecutionId?: ExecutionId): Execution {
    return {
      executionId: `${this.spec.turnId}:exec:${++this.#executionOrdinal}` as ExecutionId,
      ...(parentExecutionId ? { parentExecutionId } : {}),
      callId,
      toolName,
      input,
      children: new Set(),
      open: true,
      admitted: false,
    };
  }

  #check(): void {
    if (this.signal.aborted || this.#closed) throw cancelled();
  }

  #checkBody(execution: Execution): void {
    this.#check();
    if (!execution.open || !execution.admitted) throw new Error('Tool execution capability is no longer active');
  }

  #checkStart(execution: Execution): void {
    this.#check();
    if (!execution.open) throw new Error('Tool execution capability is no longer active');
    if (!this.#stop || this.#stop.executionId === execution.executionId) return;
    if (
      !this.#stop.executionId &&
      this.#stop.parentExecutionId === execution.parentExecutionId &&
      this.#stop.toolName === execution.toolName &&
      (this.#stop.sourceCallId === undefined || this.#stop.sourceCallId === execution.callId)
    ) {
      this.#stop.executionId = execution.executionId;
      return;
    }
    throw new Error('Tool execution stopped after interaction resolution');
  }
}

function readyParallel(plan: Plan): boolean {
  return plan.parallelSafe && plan.approval?.kind === 'none' && !plan.result;
}

function errorResult(error: unknown): ToolResult {
  return { output: error instanceof Error ? error.message : String(error), isError: true };
}

/** Audit normalization never replaces the structured value returned to a script. */
function childResult(value: unknown): ToolResult {
  if (typeof value === 'object' && value !== null && 'output' in value && typeof value.output === 'string') {
    const result = value as ToolResult;
    return {
      output: result.output,
      isError: result.isError === true,
      ...(result.providerOutput !== undefined ? { providerOutput: result.providerOutput } : {}),
      ...(result.display !== undefined ? { display: result.display } : {}),
    };
  }
  if (typeof value === 'string') return { output: value, isError: false };
  try {
    return { output: JSON.stringify(value) ?? String(value), isError: false };
  } catch {
    return { output: 'Unserializable tool result', isError: false };
  }
}
