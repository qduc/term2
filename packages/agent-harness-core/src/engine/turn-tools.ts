/** Turn-local tool planning, physical admission, interactions and ordered settlement. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Item, ToolCallId, ModelRequest } from '../model/index.js';
import type {
  ApprovalRequirement,
  ExecutionId,
  InteractionDecision,
  InteractionRequestId,
  Tool,
  ToolContext,
  ToolInteractionRequest,
  ToolResult,
  ToolRegistry,
} from '../tools/contracts.js';
import type { TurnDeps, TurnSpec } from './types.js';
import { NativeBudgetExhausted, type TurnBudgetControl } from './turn-budget.js';
import { TurnEvents, cancelled } from './turn-events.js';
import { TurnToolInteractions } from './turn-tool-interactions.js';
import { childResult, errorResult, toolResultItem } from './turn-tool-results.js';
import { batchRequest, batched, runApprovalBatch } from './turn-tool-batch.js';

type CallItem = Extract<Item, { type: 'tool_call' }>;
type Execution = {
  readonly executionId: ExecutionId;
  readonly parentExecutionId?: ExecutionId;
  readonly callId: ToolCallId;
  readonly toolName: string;
  input: unknown;
  rawArguments?: string;
  readonly children: Set<Promise<unknown>>;
  open: boolean;
  admitted: boolean;
  /** A question already answered in the response's approval batch, read once by the tool body. */
  answer?: InteractionDecision;
  /** The scoped grant chosen for this call's own approval. */
  grant?: string;
};
export type RootCall = {
  readonly item: CallItem;
  readonly executionId: ExecutionId;
  readonly execution: Execution;
  readonly modelStep: number;
};
type Plan<AppCtx> = {
  readonly call: RootCall;
  readonly tool?: Tool<unknown, AppCtx>;
  readonly context?: ToolContext<AppCtx>;
  readonly input?: unknown;
  readonly approval?: ApprovalRequirement;
  readonly parallelSafe: boolean;
  readonly result?: ToolResult;
  /** The decision legacy's approval batch applied to this call. */
  decision?: InteractionDecision;
};
type StopTarget = {
  executionId?: ExecutionId;
  readonly parentExecutionId?: ExecutionId;
  readonly sourceCallId?: string;
  readonly toolName: string;
};

export class TurnTools<AppCtx = unknown> {
  #offered: ReadonlySet<string>;
  #registry: ToolRegistry<AppCtx> | undefined;
  #physicalCalls = 0;
  #completed = 0;
  readonly #scope = new AsyncLocalStorage<Execution>();
  readonly #interactions: TurnToolInteractions<AppCtx>;
  readonly #running = new Set<Promise<unknown>>();
  #executionOrdinal = 0;
  #closed = false;
  #stop: StopTarget | undefined;
  /** Legacy ends the segment after a batch emptied by a stop decision settles. */
  #batchStopped = false;

  constructor(
    readonly spec: TurnSpec,
    readonly deps: TurnDeps<AppCtx>,
    readonly signal: AbortSignal,
    readonly events: TurnEvents,
    readonly budget: TurnBudgetControl<AppCtx>,
  ) {
    this.#offered = new Set(spec.tools.map((tool) => tool.name));
    this.#registry = deps.tools;
    this.#interactions = new TurnToolInteractions(spec, deps, signal, events, budget);
  }

  /** Bind declarations AND execution authority to this actual request snapshot. */
  bindRequest(request: ModelRequest, registry?: ToolRegistry<AppCtx>): void {
    this.#offered = new Set(request.tools.map((tool) => tool.name));
    this.#registry = registry ?? this.deps.tools;
  }

  get completed(): number {
    return this.#completed;
  }
  get exhausted(): boolean {
    return this.spec.limits !== undefined && this.#physicalCalls >= this.spec.limits.maxToolCalls;
  }

  get stopped(): boolean {
    return this.#stop !== undefined || this.#batchStopped;
  }

  /** Provider call IDs are presentation only; even repeated IDs allocate a fresh occurrence. */
  root(item: CallItem, modelStep: number): RootCall {
    const execution = this.#allocate(item.toolName, item.input, item.callId);
    execution.rawArguments = item.rawArguments;
    return { item, executionId: execution.executionId, execution, modelStep };
  }

  /** Plan all complete calls, decide them like legacy's approval batch (turn-tool-batch.ts),
   * then settle contiguous safe batches in provider order. */
  async run(calls: readonly RootCall[], history: Item[]): Promise<void> {
    const plans: Plan<AppCtx>[] = [];
    for (const call of calls) {
      plans.push(
        ['goal_check', 'session_rollover'].includes(call.item.toolName) && calls.length !== 1
          ? {
              call,
              parallelSafe: false,
              result: errorResult(`${call.item.toolName} must be called by itself after other tool results`),
            }
          : await this.#plan(call),
      );
    }
    let position = 0;
    this.#batchStopped = await runApprovalBatch(
      plans,
      async (plan) => {
        this.#check();
        const request = batchRequest(plan.approval, plan.call.execution);
        return request ? this.#interactions.request(plan.call.execution, request) : { kind: 'allow' };
      },
      async (limit) => {
        position = await this.#settle(plans, position, limit, history);
      },
    );
  }

  async #settle(plans: readonly Plan<AppCtx>[], start: number, limit: number, history: Item[]): Promise<number> {
    let position = start;
    const configured = this.deps.maxParallelToolCalls ?? 3;
    const width = Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 3;
    while (position < limit) {
      this.#check();
      const group = [plans[position++]!];
      while (position < limit && group.length < width && readyParallel(group[0]!) && readyParallel(plans[position]!)) {
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
    return position;
  }

  /** Only a live, durably opened request can consume a matching decision. */
  answer(id: InteractionRequestId, decision: InteractionDecision): void {
    this.#interactions.answer(id, decision);
  }

  cancel(): void {
    this.#closed = true;
    this.#interactions.cancel();
  }

  async cleanup(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
    this.#scope.disable();
  }

  async #plan(call: RootCall): Promise<Plan<AppCtx>> {
    this.#check();
    const base = { call, parallelSafe: false };
    if (!this.#offered.has(call.item.toolName))
      return { ...base, result: errorResult(`Unknown tool: ${call.item.toolName}`) };
    const tool = this.#registry?.get(call.item.toolName);
    if (!tool) return { ...base, result: errorResult(`Unknown tool: ${call.item.toolName}`) };
    if (this.deps.toolContext === undefined && !this.deps.createToolContext)
      return { ...base, result: errorResult('Tool execution context is unavailable') };
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

  async #runRoot(plan: Plan<AppCtx>): Promise<ToolResult> {
    const execution = plan.call.execution;
    try {
      this.#check();
      if (this.stopped) return errorResult('Tool execution stopped after interaction resolution');
      // Legacy records a call answered at once (unknown tool, bad input) as started and finished.
      const immediate = plan.result;
      if (immediate)
        return await this.#physical(
          execution,
          async () => immediate,
          (r) => r,
        );
      if (plan.approval?.kind === 'deny') return errorResult(plan.approval.reason);
      if (plan.approval?.kind === 'question') execution.answer = plan.decision;
      if (plan.decision?.kind === 'allow' && plan.decision.grant) execution.grant = plan.decision.grant;
      if (plan.approval?.kind === 'ask' && plan.decision?.kind !== 'allow') {
        const reason = plan.decision?.kind === 'deny' ? plan.decision.reason : undefined;
        return errorResult(
          reason ? `Tool execution was not approved. User's reason: ${reason}` : 'Tool execution was not approved.',
        );
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
    } catch (error) {
      if (error instanceof NativeBudgetExhausted) return errorResult(error.message);
      throw error;
    } finally {
      execution.open = false;
    }
  }

  async #result(call: RootCall, result: ToolResult, history: Item[]): Promise<void> {
    const item = toolResultItem(call.executionId, call.item, result);
    await this.events.publish({ type: 'item', item, executionId: call.executionId, modelStep: call.modelStep });
    history.push(item);
    if (result.stopAfterExecution) this.#stop = call.execution;
  }

  #context(root: Execution): ToolContext<AppCtx> {
    const current = (): Execution => this.#scope.getStore() ?? root;
    const binding = {
      turnId: this.spec.turnId,
      get parentExecutionId() {
        return current().executionId;
      },
      signal: this.signal,
      assertActive: () => this.#checkBody(current()),
      assertCanStart: () => this.#checkStart(current()),
      parked: () => this.deps.onTurnBoundary?.({ turnId: this.spec.turnId, kind: 'parked' }),
    };
    const app = this.deps.createToolContext ? this.deps.createToolContext(binding) : this.deps.toolContext!;
    return {
      app,
      signal: this.signal,
      runNested: (request) => {
        const parent = current();
        this.#checkBody(parent);
        this.#checkStart(parent);
        if (!this.deps.runNested) throw new Error('Direct nested execution is not configured');
        if (request.mode !== 'background') this.deps.onTurnBoundary?.({ turnId: this.spec.turnId, kind: 'parked' });
        const work = this.deps.runNested(request, {
          turnId: this.spec.turnId,
          parentExecutionId: parent.executionId,
          signal: this.signal,
        });
        parent.children.add(work);
        void work.finally(() => parent.children.delete(work)).catch(() => {});
        return work;
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
      get approvalGrant() {
        return current().grant;
      },
      executeChild: <T>(
        descriptor: { toolName: string; input: unknown; sourceCallId: string },
        operation: () => Promise<T>,
      ) => {
        const parent = current();
        this.#checkBody(parent);
        // Legacy's propose_goal is a run_code script tool, so a script may call it.
        if (['goal_check', 'session_rollover'].includes(descriptor.toolName))
          throw new Error(`${descriptor.toolName} is root-only`);
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
    if (this.exhausted) throw new NativeBudgetExhausted('Turn tool-call budget exhausted');
    ++this.#physicalCalls;
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
    this.budget.toolCall(execution.toolName, execution.input, this.#rawArguments(execution));
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
      ++this.#completed;
    } finally {
      // Detached descendants are still physical work owned by this execution.
      while (execution.children.size > 0) await Promise.allSettled([...execution.children]);
    }
    if (failed) throw error;
    return value;
  }

  async #interact(execution: Execution, input: ToolInteractionRequest): Promise<InteractionDecision> {
    this.#check();
    const nested =
      input.toolName !== execution.toolName ||
      (input.sourceCallId !== undefined && input.sourceCallId !== execution.callId);
    // The approval batch already asked this call's own question.
    const answered = execution.answer;
    if (!nested && input.kind === 'question' && answered) {
      execution.answer = undefined;
      return answered;
    }
    if (this.stopped) throw new Error('Tool execution stopped after interaction resolution');
    const answer = await this.#interactions.request(execution, input);
    if (answer.stopAfterApprovalResolution || (input.kind === 'question' && answer.kind === 'deny')) {
      this.#stop ??= nested
        ? { parentExecutionId: execution.executionId, toolName: input.toolName, sourceCallId: input.sourceCallId }
        : { executionId: execution.executionId, toolName: input.toolName };
    }
    return answer;
  }

  #rawArguments(execution: Execution): string {
    if (execution.rawArguments !== undefined) return execution.rawArguments;
    try {
      return JSON.stringify(execution.input) ?? '';
    } catch {
      return '';
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
    if (this.#batchStopped) throw new Error('Tool execution stopped after interaction resolution');
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

function readyParallel<AppCtx>(plan: Plan<AppCtx>): boolean {
  return plan.parallelSafe && plan.approval?.kind === 'none' && !batched(plan.approval) && !plan.result;
}
