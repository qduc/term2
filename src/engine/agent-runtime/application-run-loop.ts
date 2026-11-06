import { unwrapContinuationHandle, type ContinuationHandle } from '../../shared/contracts/continuation-handle.js';
import type { ApplicationAgent } from '../../shared/contracts/nested-run-driver.js';
import type { ProviderInput, ProviderInputItem } from '../../shared/contracts/provider-input.js';
import { conversationTimeGap } from '../../shared/conversation/conversation-time-gap.js';
import { withPersonalMemoryContext } from '../../shared/conversation/personal-memory-context.js';
import { MaxTurnsExceededError } from '../../tools/subagents/max-turns-error.js';
import { type AgentStream } from '../agent-stream.js';
import { ModelExchangeRequest } from './model-exchange.js';
import { evaluateRunBudget } from './run-budget-policy.js';
import { normalizeApplicationInput } from './run-input.js';
import type {
  ApplicationRunLoopDeps,
  ApplicationRunLoopOptions,
  ApplicationTurnSession,
  SteerOutcome,
} from './run-loop-contracts.js';
import { RunRequestBuilder } from './run-request-builder.js';
import { RunResponseRecorder } from './run-response-recorder.js';
import { EventQueue, finish, outputPush } from './run-segment-events.js';
import { RunSegments } from './run-segments.js';
import type { RunContext, RunState } from './run-state.js';
import { createRunState, refreshContinuation } from './run-state.js';
import { RunToolRound } from './run-tool-round.js';
import { ToolCallExecution } from './tool-call-execution.js';
import { TurnInputMailbox } from './turn-input-mailbox.js';
export type { AgentModelSettings, ApplicationAgent } from '../../shared/contracts/nested-run-driver.js';
export { normalizeApplicationInput, toModelTools } from './run-input.js';
export type {
  ApplicationBoundaryCompaction,
  ApplicationRequestPreparation,
  ApplicationRunLoopDeps,
  ApplicationRunLoopDiagnosticOptions,
  ApplicationRunLoopOptions,
  ApplicationTurnSession,
  NormalStopDecision,
  SteerOutcome,
} from './run-loop-contracts.js';
export { MaxTurnsExceededError };
/**
 * Small provider-neutral agent loop. It owns model-turn sequencing and tool
 * execution; providers only implement `StreamedModelTurn`.
 */
export class ApplicationRunLoop {
  readonly #deps: ApplicationRunLoopDeps;
  readonly #turnInputMailbox: TurnInputMailbox;
  #activeTurnController: AbortController | null = null;
  readonly #segments: RunSegments;
  readonly #builder: RunRequestBuilder;
  readonly #modelExchange: ModelExchangeRequest;
  readonly #recorder: RunResponseRecorder;
  readonly #tools: RunToolRound;

  constructor(deps: ApplicationRunLoopDeps) {
    this.#deps = deps;
    this.#turnInputMailbox = new TurnInputMailbox((message, meta) => this.#deps.logDiagnostic?.(message, meta));
    this.#segments = new RunSegments(this.#turnInputMailbox);
    const admit = (state: RunState, stream: AgentStream, queue: EventQueue) =>
      this.#admitPendingSteers(state, stream, queue);
    const notice = (text: string) => this.#queuePendingSystemNotice(text);
    const waitForBudget = (context: RunContext) => this.#waitForBudget(context);
    this.#builder = new RunRequestBuilder(
      deps.contextCompactionSessionState ?? { disabled: false },
      admit,
      (state, stream, queue) => evaluateRunBudget(state, stream, queue, deps.logDiagnostic),
      waitForBudget,
      notice,
    );
    this.#modelExchange = new ModelExchangeRequest(deps, notice, admit);
    this.#recorder = new RunResponseRecorder(deps);
    this.#tools = new RunToolRound(this.#recorder, waitForBudget, (context) => this.#waitForDecision(context));
  }
  /**
   * Declare a turn open, making it steerable before its first run exists.
   *
   * Anything still waiting belongs to a turn that never closed, and can never
   * be admitted now.
   */
  openTurn(): void {
    this.#turnInputMailbox.openTurn();
  }

  /**
   * Declare the turn over. Whatever is still waiting had no boundary left, so
   * it is handed back for the caller to send as its own turn.
   */
  closeTurn(): void {
    this.#turnInputMailbox.closeTurn();
  }

  abort(): void {
    this.#activeTurnController?.abort();
    this.abortSegment();
    // An aborted turn will not resume, so nothing may keep waiting on it.
    this.#turnInputMailbox.abortTurn();
  }

  /**
   * Stop the segment currently streaming without judging the turn's fate.
   *
   * Resuming a paused turn goes through here, so waiting injections survive;
   * only `abort`, which means the turn itself is over, discards them.
   */
  abortSegment(): void {
    this.#segments.abort();
  }

  /**
   * Grant one finite continuation extension to the current logical run.
   *
   * The interactive prompt calls this before resuming because it has to show
   * the human a refusal rather than a silent stop. The grant is recorded so the
   * matching `approve` does not charge a second one.
   */
  grantRunBudgetExtension(grantedBy: 'parent' | 'human' = 'human'): { granted: boolean; extensionsGranted: number } {
    return this.#segments.grantExtension(grantedBy);
  }
  #createToolCallExecution(): ToolCallExecution {
    return new ToolCallExecution({
      toolLifecycle: this.#deps.toolLifecycle,
      resolveMaxParallelToolCalls: this.#deps.resolveMaxParallelToolCalls,
      isMaxTurnsExceeded: (error) => error instanceof MaxTurnsExceededError,
      logDiagnostic: this.#deps.logDiagnostic,
    });
  }

  steer(items: readonly ProviderInputItem[], options?: { id?: string }): Promise<SteerOutcome> {
    return this.#turnInputMailbox.offer(items, options);
  }

  retractSteer(id: string): boolean {
    return this.#turnInputMailbox.retract(id);
  }

  /**
   * Replace a waiting steer's items in place, keeping its position (and thus
   * its priority relative to other pending steers) and its id. Returns
   * `false` when the id is unknown, including when it was already admitted —
   * same synchronicity invariant as `retractSteer`.
   */
  editSteer(id: string, items: readonly ProviderInputItem[]): boolean {
    return this.#turnInputMailbox.edit(id, items);
  }

  /**
   * Append waiting steers to the turn as ordinary user messages.
   *
   * They enter history and model input exactly as a user turn does — never
   * folded into a tool result — so the provider sees the user speaking after
   * the tool results of the round that was in flight when they typed.
   */
  startStream(agent: ApplicationAgent, input: ProviderInput, options: ApplicationRunLoopOptions = {}): AgentStream {
    return this.#run(this.#createState(agent, input, options), options);
  }
  #createState(agent: ApplicationAgent, input: ProviderInput, options: ApplicationRunLoopOptions): RunState {
    this.#turnInputMailbox.startStream();
    return createRunState(agent, input, options, this.#createToolCallExecution());
  }

  /** Root turns use the same loop; session operations never dispatch a run. */
  async runTurn(session: ApplicationTurnSession): Promise<void> {
    const controller = new AbortController();
    this.#activeTurnController = controller;
    try {
      await this.#runTurn(undefined, session, controller.signal);
    } finally {
      if (this.#activeTurnController === controller) this.#activeTurnController = null;
    }
  }

  continueRunStream(handle: ContinuationHandle, options: ApplicationRunLoopOptions = {}): AgentStream {
    const state = unwrapContinuationHandle(handle) as RunState;
    if (!state || typeof state !== 'object' || !('agent' in state) || !('input' in state)) {
      throw new Error('Invalid application continuation state');
    }
    if (!state.live?.resume) throw new Error('Application turn is not waiting for continuation');
    refreshContinuation(state, options);
    return this.#run(state, options);
  }
  #run(state: RunState, options: ApplicationRunLoopOptions): AgentStream {
    const current = this.#segments.open(state, options);
    if (state.live) {
      const resume = state.live.resume!;
      Object.assign(state.live, current, { resume: undefined });
      resume();
    } else {
      state.live = current;
      void this.#runTurn(current).then(
        (value) => this.#segments.settle(current, value),
        (error) => this.#segments.settle(current, undefined, error),
      );
    }
    return current.stream;
  }

  #observe(context: RunContext): void {
    context.session!.beginSegment(context.stream);
    context.observation = context.session!.consume(context.stream);
    void context.observation.catch(() => undefined);
  }

  async #completeTurn(context: RunContext): Promise<unknown> {
    const value = finish(context.stream, context.state, context.queue);
    if (context.session) {
      this.#segments.settle(context, value);
      await context.observation;
      await context.session.completed(context.stream);
    }
    return value;
  }
  /** Publish a paused view and suspend here until its owner reconnects or cancels. */
  async #waitForDecision(context: RunContext): Promise<void> {
    if (context.session) {
      this.#segments.settle(context, finish(context.stream, context.state, context.queue), undefined, true);
      await context.observation;
      const options = await context.session.interrupted(context.stream);
      this.#assertLive(context);
      refreshContinuation(context.state, options);
      Object.assign(
        context,
        this.#segments.open(context.state, { ...options, signal: context.turnSignal }, (event) =>
          context.session!.acceptEvent(event),
        ),
      );
      this.#observe(context);
      return;
    }
    const { state, stream, queue, options } = context;
    await new Promise<void>((resolve, reject) => {
      const signal = options.signal;
      const abort = () => {
        context.resume = undefined;
        reject(Object.assign(new Error('Operation aborted'), { name: 'AbortError' }));
      };
      context.resume = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      this.#segments.settle(context, finish(stream, state, queue));
    });
  }

  /** A budget decision resumes this exact boundary without recounting it. */
  async #waitForBudget(context: RunContext): Promise<boolean> {
    const { state } = context;
    while (state.pendingRunBudgetInteraction) {
      if (state.runBudgetInteractionDecision === 'stop') {
        if ((context.session?.recordBudgetStopCause || this.#deps.recordBudgetStopCause) && !state.terminalCause)
          state.terminalCause = 'budget_exhausted';
        state.pendingRunBudgetInteraction = undefined;
        state.runBudgetInteractionDecision = undefined;
        return true;
      }
      if (state.runBudgetInteractionDecision === 'continue') {
        state.pendingRunBudgetInteraction = undefined;
        state.runBudgetInteractionDecision = undefined;
        return false;
      }
      context.stream.interruptions = [state.pendingRunBudgetInteraction];
      await this.#waitForDecision(context);
    }
    return false;
  }

  /** Route boundary advice through the same admission lane as mode notices. */
  #queuePendingSystemNotice(text: string): void {
    this.#turnInputMailbox.enqueueInternal({ type: 'message', role: 'user', content: `[Mode Notice] ${text}` });
  }

  #admitPendingSteers(state: RunState, stream: AgentStream, queue: EventQueue): void {
    this.#turnInputMailbox.admitAtRequestBoundary((item) => {
      // Earlier pending steers become history only here, in FIFO order.
      if (item.role === 'user' && item.humanInputAt !== undefined) {
        item = {
          ...item,
          conversationTimeGap: conversationTimeGap(
            typeof item.humanInputAt === 'string' ? item.humanInputAt : undefined,
            state.history,
          ),
        };
      }
      const text =
        typeof item.content === 'string'
          ? item.content
          : Array.isArray(item.content)
          ? item.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
          : '';
      if (item.role === 'user' && !text.startsWith('[Mode Notice]')) state.completionRepairDeadline = undefined;
      item = withPersonalMemoryContext(item, state.history, state.agent.resolvePersonalContext);
      state.history.push(item);
      state.input.push(...normalizeApplicationInput([item]));
      outputPush(stream, queue, { type: 'item', item });
    }, state.turnCount);
  }

  /** The single model → tools → model cycle, shared by root and nested turns. */
  async #runTurn(context?: RunContext, session?: ApplicationTurnSession, turnSignal?: AbortSignal): Promise<unknown> {
    while (true) {
      try {
        turnSignal?.throwIfAborted();
        if (!context) {
          const start = await session!.prepare(turnSignal!);
          turnSignal?.throwIfAborted();
          if (!start) return;
          const options = { ...start.options, signal: turnSignal };
          const state = this.#createState(start.agent, start.input, options);
          if (session!.approvalBatch) state.approvalQueue = [];
          refreshContinuation(state, options);
          context = this.#segments.open(state, options, (event) => session!.acceptEvent(event));
          context.session = session;
          context.turnSignal = turnSignal;
          state.live = context;
          this.#observe(context);
        }
        this.#assertLive(context);
        // New explicit user authority supersedes a harness repair continuation before its deadline is applied.
        this.#admitPendingSteers(context.state, context.stream, context.queue);
        if (await this.#segments.withinRepairDeadline(context, () => this.#builder.prepareBoundary(context!)))
          return await this.#completeTurn(context);
        // Resolve the model before constructing each attempt, including retries.
        const response = await this.#segments.withinRepairDeadline(context, () =>
          this.#modelExchange.askModel(context!, () => this.#builder.build(context!)),
        );
        this.#assertLive(context);
        const calls = this.#recorder.record(context, response);
        if (await this.#segments.withinRepairDeadline(context, () => this.#tools.execute(context!, response, calls)))
          return await this.#completeTurn(context);
        if (calls.length === 0 && (await this.#finishTurn(context))) return await this.#completeTurn(context);
      } catch (error) {
        if (context?.completionRepairExpired) {
          context.state.terminalCause = 'completion_verification_blocked';
          this.#appendStopNotice(
            context,
            'Completion verification blocked: the repair task deadline expired. The durable goal remains active.',
          );
          return await this.#completeTurn(context);
        }
        if (!session) throw error;
        if (context) {
          this.#segments.settle(context, undefined, error);
          await context.observation?.catch(() => undefined);
        }
        if (session.isFatalError?.(error)) throw error;
        turnSignal?.throwIfAborted();
        if (!(await session.recover(error))) return;
        context = undefined;
      }
    }
  }
  #appendStopNotice(context: RunContext, notice: string): void {
    const text = `\n\n${notice}`;
    context.stream.finalOutput = (context.stream.finalOutput ?? '') + text;
    context.queue.push({ type: 'text_delta', text });
  }

  #assertLive(context: RunContext): void {
    if (context.options.signal?.aborted) throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
  }
  /** Normal no-tool completion; only an explicit stop-policy continuation repeats. */
  async #finishTurn(context: RunContext): Promise<boolean> {
    const { state, options } = context;
    // The normal stop seam. A stop policy may keep the same run going; the
    // reminder is admitted at the next request boundary, where pending
    // budget evidence pauses first and turn accounting applies as usual.
    const stopDecision =
      options.onNormalStop && !options.signal?.aborted && !state.criticalWrapUpPending
        ? await options.onNormalStop(state.history, state.agent, context.requestAbortController.signal)
        : undefined;
    if (stopDecision) {
      this.#deps.logDiagnostic?.(
        'Normal stop policy decided',
        { action: stopDecision.action, turnCount: state.turnCount, ...stopDecision.diagnostics },
        { severity: 'debug', eventType: 'run_loop.normal_stop_policy' },
      );
    }
    if (stopDecision?.action === 'continue') {
      if (stopDecision.repairDeadline !== undefined) state.completionRepairDeadline = stopDecision.repairDeadline;
      this.#queuePendingSystemNotice(stopDecision.reminder);
      return false;
    }
    if (stopDecision?.terminalCause) state.terminalCause = stopDecision.terminalCause;
    if (stopDecision?.action === 'stop' && stopDecision.notice) {
      this.#appendStopNotice(context, stopDecision.notice);
    }
    // Evidence discovered when a response has already completed needs no
    // human boundary: there is no later request or tool to block.
    state.pendingRunBudgetInteraction = undefined;
    return true;
  }
}
