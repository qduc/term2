/** Execution-owned interaction receipts; TurnTools retains scheduling and stop selection. */
import type {
  InteractionDecision,
  InteractionRequestId,
  ToolInteractionRequest,
  ExecutionId,
} from '../tools/contracts.js';
import type { ToolCallId } from '../model/index.js';
import type { InteractionRequest, TurnDeps, TurnSpec } from './types.js';
import type { TurnBudgetControl } from './turn-budget.js';
import { TurnEvents, cancelled } from './turn-events.js';

export type InteractionExecution = {
  readonly executionId: ExecutionId;
  readonly parentExecutionId?: ExecutionId;
  readonly callId: ToolCallId;
  readonly toolName: string;
};
type PendingInteraction = {
  readonly request: InteractionRequest;
  ready: boolean;
  resolve(decision: InteractionDecision): void;
  reject(error: Error): void;
};

/** Publishes one durable question before admitting its matching answer. */
export class TurnToolInteractions<AppCtx = unknown> {
  readonly #pending = new Map<InteractionRequestId, PendingInteraction>();
  #ordinal = 0;
  #closed = false;

  constructor(
    readonly spec: TurnSpec,
    readonly deps: TurnDeps<AppCtx>,
    readonly signal: AbortSignal,
    readonly events: TurnEvents,
    readonly budget: TurnBudgetControl<AppCtx>,
  ) {}

  answer(id: InteractionRequestId, decision: InteractionDecision): void {
    const pending = this.#pending.get(id);
    if (!pending?.ready || this.#closed || this.signal.aborted) return;
    if (pending.request.kind === 'approval' && decision.kind === 'answer') return;
    if (pending.request.kind === 'question' && decision.kind === 'allow') return;
    this.#pending.delete(id);
    pending.resolve(decision);
  }

  cancel(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(cancelled());
    this.#pending.clear();
  }

  async request(execution: InteractionExecution, input: ToolInteractionRequest): Promise<InteractionDecision> {
    this.#check();
    const nested =
      input.toolName !== execution.toolName ||
      (input.sourceCallId !== undefined && input.sourceCallId !== execution.callId);
    const request: InteractionRequest = {
      ...input,
      requestId: `${this.spec.turnId}:question:${++this.#ordinal}` as InteractionRequestId,
      turnId: this.spec.turnId,
      ...(nested
        ? { parentExecutionId: execution.executionId }
        : {
            executionId: execution.executionId,
            ...(execution.parentExecutionId ? { parentExecutionId: execution.parentExecutionId } : {}),
          }),
    };
    const decision = new Promise<InteractionDecision>((resolve, reject) => {
      this.#pending.set(request.requestId, { request, ready: false, resolve, reject });
    });
    void decision.catch(() => {});
    try {
      await this.events.publish({ type: 'interaction_required', request }, () => {
        const pending = this.#pending.get(request.requestId);
        if (pending) pending.ready = true;
      });
      const answer = await this.budget.humanWait(() => decision);
      this.#check();
      return answer;
    } finally {
      this.#pending.delete(request.requestId);
    }
  }

  #check(): void {
    if (this.signal.aborted || this.#closed) throw cancelled();
  }
}
