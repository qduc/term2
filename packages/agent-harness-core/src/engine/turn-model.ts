/** The sole direct model boundary: preparation, recovery and accepted continuity. */
import { delay, recoveryFailure, toModelError } from './turn-model-errors.js';
export { toModelError } from './turn-model-errors.js';
import type { Item, ItemId, ModelEvent, ModelRequest, Usage } from '../model/index.js';
import type { DirectManualCompactionOutcome, TurnDeps, TurnSpec } from './types.js';
import {
  DirectRecovery,
  exhaustedNotice,
  RetriesExhausted,
  type DirectRecoveryDecision,
  type DirectRetryNotice,
} from './recovery.js';
import { DirectContinuity, selfContained } from './recovery-continuity.js';
import { hasCompleteDirectToolPairs } from './recovery-history.js';
import { CompactionWrapUp, TurnCompaction } from './turn-model-compaction.js';
import { enforceDirectInputLimit } from './recovery-compaction.js';
import { NativeBudgetExhausted, serviceTierForRequest, type TurnBudgetControl } from './turn-budget.js';
import { TurnEvents, cancelled } from './turn-events.js';
import { TurnTools, type RootCall } from './turn-tools.js';

type Done = Extract<ModelEvent, { type: 'done' }>;
class SteeringInterrupt extends Error {}

type Retry = Extract<DirectRecoveryDecision, { kind: 'retry' }>;

export class TurnModel<AppCtx = unknown> {
  readonly #recovery: DirectRecovery;
  readonly #continuity: DirectContinuity;
  #step = 0;
  #mainRequests = 0;
  #hasOutput = false;
  #requestHasOutput = false;
  /** The last failed request's text-only output, which legacy's run loop withdraws before a retry. */
  #withdrawable: { modelStep: number; start: number; count: number; hadOutput: boolean } | undefined;
  #interruptTextStream?: () => void;
  readonly #compaction: TurnCompaction<AppCtx>;
  #standardTier = false;
  #downgraded = false;

  constructor(
    readonly spec: TurnSpec,
    readonly deps: TurnDeps<AppCtx>,
    readonly signal: AbortSignal,
    readonly events: TurnEvents,
    readonly tools: TurnTools<AppCtx>,
    readonly budget: TurnBudgetControl<AppCtx>,
  ) {
    // Even an unconfigured direct run owns its physical boundary: no hidden
    // adapter retries. Real retry counts are supplied by the composition root.
    this.#recovery = new DirectRecovery(deps.recovery ?? { maxTransientRetries: 0, maxModelRetries: 0 });
    this.#continuity = deps.continuity?.state ?? new DirectContinuity();
    this.#compaction = new TurnCompaction(
      spec,
      deps,
      signal,
      events,
      budget,
      (request, history, instructions) => this.#auxiliary(request, history, instructions),
      () => this.#continuity.clear(),
    );
  }

  /** Retry only a model request, from accepted history and after all tools settle. */
  async run(history: Item[]): Promise<RootCall[]> {
    let retry: Retry | undefined;
    while (true) {
      const prepared = await this.#prepare(history, retry);
      try {
        const response = await this.#stream(prepared.request, history, prepared.modelStep);
        // A terminal checkpoint is distinct from accepted deltas/items/usage.
        await this.events.publish({
          type: 'model_response_completed',
          modelStep: prepared.modelStep,
          stopReason: response.done.stopReason,
          ...(response.done.continuation !== undefined ? { continuation: response.done.continuation } : {}),
          ...(response.done.providerMetadata !== undefined ? { providerMetadata: response.done.providerMetadata } : {}),
          ...(response.done.costUsd !== undefined ? { costUsd: response.done.costUsd } : {}),
        });
        this.#recovery?.responseAccepted();
        if (prepared.ticket !== undefined)
          this.#continuity.accept({ ticket: prepared.ticket, history, continuation: response.done.continuation });
        if (this.budget.wrappingUp)
          throw new NativeBudgetExhausted('Child run budget exhausted after its tools-disabled wrap-up');
        if (
          response.calls.length &&
          (response.done.stopReason === 'max_tokens' || response.done.stopReason === 'refusal')
        ) {
          throw new Error(`Model response ended with ${response.done.stopReason}; tool calls were not executed.`);
        }
        return response.calls;
      } catch (error) {
        this.#continuity.clear();
        if (this.signal.aborted) throw cancelled();
        if (error instanceof SteeringInterrupt) {
          // A recovery dispatch has already spent its reservation. The steered
          // continuation needs its own physical claim, not a reused ticket.
          if (retry && !this.#recovery.budget.claimPhysicalAttempt())
            throw new Error('Recovery budget exhausted before steered continuation.');
          continue;
        }
        const pairs = hasCompleteDirectToolPairs(history);
        const decision = this.#recovery?.recover({
          failure: recoveryFailure(error),
          cancelled: false,
          fullHistoryAvailable: pairs,
          freshStartAllowed: pairs,
          hasCommittedOutput: this.#hasOutput,
          hasCurrentRequestOutput: this.#requestHasOutput,
          withdrawableOutput: this.#withdrawable !== undefined,
          tools: { completed: this.tools.completed, allCompleted: true, completedPairsInHistory: pairs },
        });
        // A terminal attempt keeps its accepted partial text. Only a selected retry withdraws it.
        if (decision.kind === 'stop')
          throw decision.exhaustedAfter === undefined
            ? error
            : new RetriesExhausted(error, exhaustedNotice(this.spec.model.provider, decision.exhaustedAfter));
        if (decision.notice) await this.#retryNotice(decision.notice, error);
        retry = decision;
        if (retry.withdraw) await this.#withdraw(history);
        this.#standardTier ||= retry.useStandardServiceTier;
        this.#downgraded ||= retry.downgradeTransport;
        if (retry.downgradeTransport) this.#continuity.breakChaining();
        const remaining = this.#recovery.budget.remainingMs();
        // Respect upstream Retry-After without sleeping past the existing
        // recovery envelope or inventing a shorter permitted retry delay.
        if (remaining !== undefined && retry.delayMs >= remaining) throw error;
        // Legacy observes only its model-behavior retries; transport retries stay silent (SDK-level).
        const { attempt, maxRetries, delayMs } = retry;
        if (retry.recovery === 'model_behavior')
          await this.events.publish({ type: 'model_retrying', attempt, maxRetries, delayMs });
        await delay(retry.delayMs, this.signal);
      }
    }
  }

  /** Run only the explicit compaction operation; summaries never become root assistant Items. */
  async compact(history: Item[]): Promise<DirectManualCompactionOutcome> {
    if (!this.deps.compaction) return { kind: 'blocked', reason: 'unavailable' };
    while (true) {
      try {
        const surface = await this.#request(history, this.#step + 1);
        const result = await this.#compaction.compact(surface.request, history, true);
        if (result.kind === 'compacted')
          return {
            kind: 'compacted',
            tokensBefore: result.before.renderedInputTokens,
            tokensAfter: result.estimate.renderedInputTokens,
          };
        return { kind: 'blocked', reason: result.kind === 'blocked' ? result.reason : result.kind };
      } catch (error) {
        if (this.signal.aborted) throw cancelled();
        if (error instanceof NativeBudgetExhausted) throw error;
        // Auxiliary summary text is private proposal data, not committed root
        // output or a tool effect. Retrying it cannot replay accepted tools.
        const pairs = hasCompleteDirectToolPairs(history);
        const decision = this.#recovery.recover({
          failure: recoveryFailure(error),
          cancelled: false,
          fullHistoryAvailable: pairs,
          freshStartAllowed: pairs,
          hasCommittedOutput: false,
          hasCurrentRequestOutput: false,
          tools: { completed: 0, allCompleted: true, completedPairsInHistory: pairs },
        });
        if (decision.kind === 'stop') throw error;
        this.#standardTier ||= decision.useStandardServiceTier;
        this.#downgraded ||= decision.downgradeTransport;
        if (decision.downgradeTransport) this.#continuity.breakChaining();
        const remaining = this.#recovery.budget.remainingMs();
        if (remaining !== undefined && decision.delayMs >= remaining) throw error;
        await delay(decision.delayMs, this.signal);
      }
    }
  }

  /** Legacy's run loop rolls back a failed attempt's partial text before retrying it. */
  async #withdraw(history: Item[]): Promise<void> {
    const withdrawn = this.#withdrawable;
    if (!withdrawn) return;
    this.#withdrawable = undefined;
    history.splice(withdrawn.start, withdrawn.count);
    this.#hasOutput = withdrawn.hadOutput;
    await this.events.publish({ type: 'text_delta', delta: '', modelStep: withdrawn.modelStep, withdrawn: true });
  }

  /** Legacy's session-level retry notice; live only, like its system message. */
  async #retryNotice(notice: DirectRetryNotice, error: unknown): Promise<void> {
    await this.events.publish({
      type: 'retrying',
      attempt: notice.attempt,
      maxRetries: notice.maxRetries,
      delayMs: notice.delayMs,
      error: toModelError(error),
      toolName: notice.retryType === 'upstream' ? 'turn' : 'conversation',
      retryType: notice.retryType,
    });
  }

  /** Request interruption only while a text-only response is actively streaming. */
  steer(): void {
    this.#interruptTextStream?.();
  }

  /** Only cancelled/failed/interrupted runs retire an accepted checkpoint. */
  clear(): void {
    this.#continuity.clear();
  }

  async #prepare(
    history: Item[],
    retry?: Retry,
  ): Promise<{ request: ModelRequest; modelStep: number; ticket?: number }> {
    await this.#steering(history);
    const reminded = !retry && (await this.#compaction.milestones(history));
    const preflight = await this.#request(history, this.#step + 1);
    // A reserved recovery dispatch belongs to the main request, never a summary.
    if (!retry && !(reminded && this.#compaction.canDefer(preflight.request)))
      await this.#compaction.compact(preflight.request, history);
    const action = await this.budget.beforeRequest(history);
    if (action === 'stop') throw new NativeBudgetExhausted('Run budget check-in stopped the run');
    // A human wait may have accumulated steering; bind snapshots only afterward.
    await this.#steering(history);
    this.#checkLimit();
    const modelStep = ++this.#step;
    const surface = await this.#request(history, modelStep);
    let request: ModelRequest = {
      ...surface.request,
      ...(action === 'wrap_up' || this.tools.exhausted ? { tools: [] } : {}),
      ...(this.#standardTier ? { useStandardServiceTier: true } : {}),
      ...(this.#downgraded ? { downgradeTransport: true } : {}),
    };
    this.#admit(request);
    // Retry budget is live state, not part of the cloneable continuity envelope.
    const prepared = this.deps.continuity
      ? this.#continuity.prepare(request, this.deps.continuity.binding, this.#mainRequests === 0)
      : undefined;
    request = prepared?.request ?? selfContained(request);
    if (retry?.disableChaining) request = selfContained(request);
    request = this.#withRecovery(request, retry?.dispatchClaimed);
    this.tools.bindRequest(request, surface.tools);
    this.budget.dispatched(action === 'wrap_up');
    ++this.#mainRequests;
    return { request, modelStep, ...(prepared ? { ticket: prepared.ticket } : {}) };
  }

  /** The turn ended: hand its last completed input tokens to the next turn's reminders. */
  settleMilestones(): void {
    this.#compaction.settleMilestones();
  }

  #admit(request: ModelRequest): void {
    enforceDirectInputLimit(request, {
      maxRequestInputTokens: this.deps.compaction?.maxRequestInputTokens,
      contextWindow:
        this.deps.compaction?.contextWindow ?? this.deps.models.resolve(request.model).catalogContextWindow,
    });
  }

  async #request(
    history: readonly Item[],
    modelStep: number,
  ): Promise<{ request: ModelRequest; tools?: TurnDeps<AppCtx>['tools'] }> {
    const request: ModelRequest = {
      model: this.spec.model,
      ...(this.spec.affinity ? { affinity: this.spec.affinity } : {}),
      instructions: this.spec.instructions,
      input: fromLastReplacementBoundary(history),
      tools: this.spec.tools,
      ...(this.spec.reasoning !== undefined ? { reasoning: this.spec.reasoning } : {}),
      ...(this.spec.temperature !== undefined ? { temperature: this.spec.temperature } : {}),
      ...(this.spec.maxOutputTokens !== undefined ? { maxOutputTokens: this.spec.maxOutputTokens } : {}),
      ...(this.spec.providerOptions !== undefined ? { providerOptions: this.spec.providerOptions } : {}),
    };
    const surface = await this.deps.prepareRequest?.(request, {
      turnId: this.spec.turnId,
      modelStep,
      signal: this.signal,
    });
    if (this.signal.aborted) throw cancelled();
    return surface ?? { request };
  }

  async #steering(history: Item[]): Promise<readonly Item[]> {
    // Session already committed queue_steered; never duplicate it as item facts.
    const items = (await this.deps.takeSteering?.(this.spec.turnId)) ?? [];
    if (this.signal.aborted) throw cancelled();
    history.push(...items);
    return items;
  }

  #withRecovery(request: ModelRequest, dispatchClaimed?: boolean): ModelRequest {
    return {
      ...request,
      // Effective fallback controls belong to every later physical inference,
      // including summary/native compaction; they are never persisted settings.
      ...(this.#standardTier ? { useStandardServiceTier: true } : {}),
      ...(this.#downgraded ? { downgradeTransport: true } : {}),
      recovery: { budget: this.#recovery.budget, ...(dispatchClaimed ? { dispatchClaimed: true } : {}) },
    };
  }

  #checkLimit(): void {
    if (this.signal.aborted) throw cancelled();
    if (this.spec.limits && this.#step >= this.spec.limits.maxModelCalls)
      throw new NativeBudgetExhausted('Turn model-call budget exhausted');
  }

  async #auxiliary(
    request: ModelRequest,
    history: Item[],
    preparedInstructions: string,
  ): Promise<{ request: ModelRequest; modelStep: number }> {
    const steering = [...(await this.#steering(history))];
    const action = await this.budget.beforeRequest(history);
    steering.push(...(await this.#steering(history)));
    if (action === 'wrap_up') throw new CompactionWrapUp();
    if (action === 'stop') throw new NativeBudgetExhausted('Run budget exhausted before context compaction');
    this.#checkLimit();
    const modelStep = ++this.#step;
    const canonical = {
      ...request,
      // The live-prefix summary inherits the preflight envelope; rebuild its
      // dynamic goal/memory layer once, rather than appending it twice. Chunk
      // summaries have their own compaction instructions and keep those intact.
      instructions: request.instructions === preparedInstructions ? this.spec.instructions : request.instructions,
      input: [...request.input, ...steering],
    };
    const surface = await this.deps.prepareRequest?.(canonical, {
      turnId: this.spec.turnId,
      modelStep,
      signal: this.signal,
    });
    if (this.signal.aborted) throw cancelled();
    // Like legacy, the live-prefix summary keeps the session's instructions and tools (its prompt says not to call
    // them); chunk summaries arrive with their own compaction instructions and no tools.
    const prepared = this.#withRecovery(selfContained(surface?.request ?? canonical));
    this.#admit(prepared);
    return { request: prepared, modelStep };
  }

  async #stream(request: ModelRequest, history: Item[], modelStep: number): Promise<{ calls: RootCall[]; done: Done }> {
    this.#requestHasOutput = false;
    this.#withdrawable = undefined;
    const hadOutput = this.#hasOutput;
    let textOnly = true;
    const calls: RootCall[] = [];
    const items: Item[] = [];
    let text = '';
    let textPosition = 0;
    let done: Done | undefined;
    let usage: Usage | undefined;
    let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
    const requestController = new AbortController();
    let interrupted = false;
    let hasToolOutput = false;
    let acceptingText = false;
    let acceptanceFailed = false;
    this.#interruptTextStream = () => {
      if ((!text && !acceptingText) || hasToolOutput || done || interrupted) return;
      interrupted = true;
      requestController.abort();
    };
    try {
      for await (const event of this.deps.models
        .resolve(request.model)
        .stream(request, AbortSignal.any([this.signal, requestController.signal]), () => {
          this.deps.onTurnBoundary?.({ turnId: this.spec.turnId, kind: 'request_dispatched' });
        })) {
        if (this.signal.aborted) throw cancelled();
        if (done) throw new Error('Model emitted events after its terminal response');
        switch (event.type) {
          case 'text_delta':
            acceptingText = true;
            try {
              await this.events.publish({ type: 'text_delta', delta: event.delta, modelStep });
            } catch (error) {
              acceptanceFailed = true;
              throw error;
            } finally {
              acceptingText = false;
            }
            if (!text) textPosition = items.length;
            text += event.delta;
            this.#hasOutput = true;
            this.#requestHasOutput = true;
            break;
          case 'reasoning_delta':
            await this.events.publish({ type: 'reasoning_delta', delta: event.delta });
            this.#hasOutput = true;
            this.#requestHasOutput = true;
            break;
          case 'tool_call_streaming_delta':
            hasToolOutput = true;
            textOnly = false;
            await this.events.publish({ ...event, turnId: this.spec.turnId, modelStep });
            // Progress already shown to the caller is physical output evidence,
            // even though it is not a completed/admitted tool or history item.
            this.#hasOutput = true;
            this.#requestHasOutput = true;
            break;
          case 'item': {
            textOnly = false;
            if (event.item.type === 'tool_call') hasToolOutput = true;
            const call = event.item.type === 'tool_call' ? this.tools.root(event.item, modelStep) : undefined;
            await this.events.publish({
              type: 'item',
              item: event.item,
              modelStep,
              ...(call ? { executionId: call.executionId } : {}),
            });
            items.push(event.item);
            this.#hasOutput = true;
            this.#requestHasOutput = true;
            if (event.item.type === 'assistant_message') text = '';
            if (call) {
              calls.push(call);
              await this.events.publish({
                type: 'tool_called',
                executionId: call.executionId,
                callId: call.item.callId,
                toolName: call.item.toolName,
                input: call.item.input,
              });
            }
            break;
          }
          case 'codex_quota':
            await this.events.publish(event);
            break;
          case 'usage':
            usage = event.usage;
            await this.events.publish({
              type: 'usage',
              usage,
              modelStep,
              ...(event.speed ? { speed: event.speed } : {}),
            });
            this.#requestHasOutput = true;
            break;
          case 'done':
            done = event;
            break;
          case 'retrying':
            // Injected recovery delegates physical retries back to this boundary.
            break;
        }
      }
      if (this.signal.aborted) throw cancelled();
      if (interrupted) throw new SteeringInterrupt();
      if (!done) throw new Error('Model stream ended before the response completed.');
      outcome = 'completed';
      this.#compaction.recordInputTokens(usage?.inputTokens);
      return { calls, done };
    } catch (error) {
      if (interrupted && !this.signal.aborted && !acceptanceFailed) {
        // Finalize the already accepted text before admitting the steer. Otherwise
        // the TUI keeps an old draft live below the new user message, and replay
        // cannot distinguish this partial from an active stream.
        if (text) {
          const partial: Item = {
            type: 'assistant_message',
            id: `${this.spec.turnId}-model-${modelStep}-partial` as ItemId,
            content: [{ type: 'text', text }],
          };
          await this.events.publish({ type: 'item', item: partial, modelStep });
          // Replay appends an accepted assistant item at its fact position.
          // Match that ordering for intervening reasoning/provider items.
          items.push(partial);
          text = '';
        }
        throw new SteeringInterrupt();
      }
      throw error;
    } finally {
      this.#interruptTextStream = undefined;
      if (text)
        items.splice(textPosition, 0, {
          type: 'assistant_message',
          id: `${this.spec.turnId}-model-${modelStep}-partial` as ItemId,
          content: [{ type: 'text', text }],
        });
      // Every retained item/delta already has its own durable Session receipt.
      if (outcome !== 'completed' && textOnly && !interrupted && items.length > 0)
        this.#withdrawable = { modelStep, start: history.length, count: items.length, hadOutput };
      history.push(...items);
      await this.budget.record({
        requestId: `${this.spec.turnId}:model:${modelStep}`,
        model: request.model,
        serviceTier: serviceTierForRequest(request),
        usage,
        costUsd: done?.costUsd,
        outcome: this.signal.aborted || interrupted ? 'cancelled' : outcome,
      });
    }
  }
}

/** Explicit replacement metadata cuts the provider prefix; additive summaries never do.
 * Local compaction already installs its entire checkpoint/tail through accepted history_replaced. */
function fromLastReplacementBoundary(history: readonly Item[]): Item[] {
  for (let index = history.length - 1; index >= 0; index--) {
    const item = history[index]!;
    if (
      (item.type === 'summary' && item.replaces.length > 0) ||
      (item.type === 'provider_opaque' && item.provider === 'openai' && item.item.type === 'compaction')
    )
      return history.slice(index);
  }
  return [...history];
}
