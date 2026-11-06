import type { ApplicationRunEvent } from '../../shared/contracts/application-stream.js';
import { createContinuationHandle } from '../../shared/contracts/continuation-handle.js';
import { createAgentStream } from '../agent-stream.js';
import type { ApplicationRunLoopOptions } from './run-loop-contracts.js';
import { EventQueue } from './run-segment-events.js';
import type { RunContext, RunState } from './run-state.js';
import { type ToolInvocationContext } from './tool-invocation-context.js';
import { TurnInputMailbox } from './turn-input-mailbox.js';
/** Owns event-view generations, cancellation and pause-aware segment settlement, not turn advancement. */
export class RunSegments {
  #activeAbortController: AbortController | null = null;
  #segmentGeneration = 0;
  #activeRunBudgetState: RunState | undefined;
  constructor(private readonly mailbox: TurnInputMailbox) {}
  abort(): void {
    this.#activeAbortController?.abort();
    this.#activeAbortController = null;
  }
  grantExtension(grantedBy: 'parent' | 'human' = 'human'): { granted: boolean; extensionsGranted: number } {
    const state = this.#activeRunBudgetState;
    if (!state?.runBudget) return { granted: false, extensionsGranted: 0 };
    const grant = state.runBudget.grantExtension(grantedBy);
    if (grant.granted) state.runBudgetGrantConsumed = true;
    return grant;
  }
  open(
    state: RunState,
    options: ApplicationRunLoopOptions,
    acceptEvent?: (event: ApplicationRunEvent) => void,
  ): RunContext {
    const queue = new EventQueue(acceptEvent);
    const segmentGeneration = ++this.#segmentGeneration;
    if (!state.live) this.abort();
    const controller = new AbortController();
    this.#activeAbortController = controller;
    this.mailbox.startSegment();
    state.runBudget?.resume();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const effectiveOptions = { ...options, signal: controller.signal };
    const toolContext: ToolInvocationContext = {
      context: state.context,
      approvals: state.approvals,
      signal: effectiveOptions.signal,
      // A getter, not a snapshot: the context object outlives every turn, and
      // tools read it while deciding whether to warn about the turn budget.
      get turn() {
        return { count: state.turnCount, max: state.maxTurns };
      },
      get budget() {
        return state.runBudget
          ? {
              takeSoftEvidence: () => state.runBudget?.takeSoftEvidence(),
              takeStallEvidence: () => state.runBudget?.takeStallEvidence(),
              remainingPolicy: () => state.runBudget?.remainingPolicy(),
            }
          : undefined;
      },
    };
    const output: ApplicationRunEvent[] = [];
    const stream = createAgentStream({
      [Symbol.asyncIterator]: () => ({ next: () => queue.next() }),
      completed: Promise.resolve(undefined),
      history: state.history,
      newItems: output,
      output,
      finalOutput: undefined,
      lastResponseId: state.responseId ?? null,
      interruptions: [],
      state: createContinuationHandle(state),
      rawResponses: [],
      terminalCause: undefined,
      get runUsage() {
        return state.usage;
      },
      get runCostRecords() {
        return state.costRecords ?? [];
      },
    });

    let resolveSegment!: (value: unknown) => void;
    let rejectSegment!: (error: unknown) => void;
    stream.completed = new Promise((resolve, reject) => {
      resolveSegment = resolve;
      rejectSegment = reject;
    });
    // The iterator may report a failure before the caller observes completed.
    void stream.completed.catch(() => undefined);
    const current = {
      state,
      stream,
      queue,
      options: effectiveOptions,
      toolContext,
      requestAbortController: controller,
      generation: segmentGeneration,
      resolveSegment,
      rejectSegment,
    };
    this.#activeRunBudgetState = state.runBudget ? state : undefined;
    return current;
  }
  /** Complete an event view; a pause leaves the owning async task alive. */
  settle(context: RunContext, value: unknown, error?: unknown, waiting = false): void {
    const { state, stream, queue, generation } = context;
    if (error === undefined) context.session?.acceptSegment(stream);
    state.runBudget?.pause();
    const cancelled = error instanceof Error && error.name === 'AbortError';
    const paused = (waiting || context.resume !== undefined) && !cancelled && error === undefined;
    if (error !== undefined) {
      stream.cancelled = cancelled;
      queue.close(error);
      context.rejectSegment(error);
    } else {
      context.resolveSegment(value);
    }
    if (generation !== this.#segmentGeneration) return;
    if (!paused && this.#activeAbortController === context.requestAbortController) this.#activeAbortController = null;
    this.mailbox.settleSegment({
      paused,
      reason: {
        pendingApprovals: state.toolExecution.pendingApprovals.length,
        pendingBudgetInteraction: state.pendingRunBudgetInteraction !== undefined,
        cancelled,
        error: error instanceof Error ? error.name : error ? String(error) : undefined,
        turnCount: state.turnCount,
      },
    });
    if (!paused && this.#activeRunBudgetState === state) this.#activeRunBudgetState = undefined;
  }
  async withinRepairDeadline<T>(context: RunContext, operation: () => Promise<T>): Promise<T> {
    const deadline = context.state.completionRepairDeadline;
    if (deadline === undefined) return operation();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<never>((_resolve, reject) => {
          const expire = () => {
            if (context.state.completionRepairDeadline !== deadline) return;
            context.completionRepairExpired = true;
            context.requestAbortController.abort();
            reject(new Error('Completion repair deadline exceeded'));
          };
          if (Date.now() >= deadline) expire();
          else timer = setTimeout(expire, deadline - Date.now());
        }),
        Promise.resolve().then(() => {
          if (context.completionRepairExpired) throw new Error('Completion repair deadline exceeded');
          return operation();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
