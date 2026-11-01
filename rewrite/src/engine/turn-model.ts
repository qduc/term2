/** The sole direct model boundary: preparation, recovery and accepted continuity. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Item, ItemId, Model, ModelError, ModelEvent, ModelRequest, Usage } from '../model/index.js';
import type { DirectManualCompactionOutcome, TurnCompactionEvent, TurnDeps, TurnSpec } from './direct-types.js';
import { DirectRecovery, type DirectRecoveryDecision, type DirectRecoveryFailure } from './direct-recovery.js';
import { DirectContinuity, selfContained } from './direct-recovery-continuity.js';
import {
  compactDirectHistory,
  estimateDirectContext,
  type DirectCompactionResult,
  type DirectCompactionRequest,
} from './direct-recovery-compaction.js';
import { hasCompleteDirectToolPairs } from './direct-recovery-history.js';
import { NativeBudgetExhausted, type TurnBudgetControl } from './turn-budget.js';
import { TurnEvents, cancelled } from './turn-events.js';
import { TurnTools, type RootCall } from './turn-tools.js';

type Done = Extract<ModelEvent, { type: 'done' }>;
type Retry = Extract<DirectRecoveryDecision, { kind: 'retry' }>;
class CompactionWrapUp extends Error {}
// A configured successful attempt must return its accepted result, not silently
// fall through as undefined and make a manual command report unavailable.
type CompactionAttemptResult = DirectCompactionResult | { readonly kind: 'unavailable' | 'wrap_up' };

export class TurnModel {
  readonly #recovery: DirectRecovery;
  readonly #continuity: DirectContinuity;
  #step = 0;
  #mainRequests = 0;
  #hasOutput = false;
  #requestHasOutput = false;
  #compactionState: TurnSpec['compactionState'];
  #lastInputTokens: number | undefined;
  #standardTier = false;
  #downgraded = false;
  #auxiliaryRetry: Retry | undefined;

  constructor(
    readonly spec: TurnSpec,
    readonly deps: TurnDeps,
    readonly signal: AbortSignal,
    readonly events: TurnEvents,
    readonly tools: TurnTools,
    readonly budget: TurnBudgetControl,
  ) {
    // Even an unconfigured direct run owns its physical boundary: no hidden
    // adapter retries. Real retry counts are supplied by the composition root.
    this.#recovery = new DirectRecovery(deps.recovery ?? { maxTransientRetries: 0, maxModelRetries: 0 });
    this.#continuity = deps.continuity?.state ?? new DirectContinuity();
    this.#compactionState = spec.compactionState;
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
        const pairs = hasCompleteDirectToolPairs(history);
        const decision = this.#recovery?.recover({
          failure: recoveryFailure(error),
          cancelled: false,
          fullHistoryAvailable: pairs,
          freshStartAllowed: pairs,
          hasCommittedOutput: this.#hasOutput,
          hasCurrentRequestOutput: this.#requestHasOutput,
          tools: { completed: this.tools.completed, allCompleted: true, completedPairsInHistory: pairs },
        });
        if (!decision || decision.kind === 'stop') throw error;
        retry = decision;
        this.#standardTier ||= retry.useStandardServiceTier;
        this.#downgraded ||= retry.downgradeTransport;
        if (retry.downgradeTransport) this.#continuity.breakChaining();
        const remaining = this.#recovery.budget.remainingMs();
        // Respect upstream Retry-After without sleeping past the existing
        // recovery envelope or inventing a shorter permitted retry delay.
        if (remaining !== undefined && retry.delayMs >= remaining) throw error;
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
        const result = await this.#compact(surface.request, history, true);
        if (result.kind === 'compacted') return { kind: 'compacted' };
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
        this.#auxiliaryRetry = decision;
        this.#standardTier ||= decision.useStandardServiceTier;
        this.#downgraded ||= decision.downgradeTransport;
        if (decision.downgradeTransport) this.#continuity.breakChaining();
        const remaining = this.#recovery.budget.remainingMs();
        if (remaining !== undefined && decision.delayMs >= remaining) throw error;
        await delay(decision.delayMs, this.signal);
      }
    }
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
    const preflight = await this.#request(history, this.#step + 1);
    // A reserved recovery dispatch belongs to the main request, never a summary.
    if (!retry) await this.#compact(preflight.request, history);
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

  async #request(
    history: readonly Item[],
    modelStep: number,
  ): Promise<{ request: ModelRequest; tools?: TurnDeps['tools'] }> {
    const request: ModelRequest = {
      model: this.spec.model,
      instructions: this.spec.instructions,
      input: [...history],
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
      throw new NativeBudgetExhausted('Native child model-call budget exhausted');
  }

  async #compact(request: ModelRequest, history: Item[], manual = false): Promise<CompactionAttemptResult> {
    if (!this.deps.compaction) return { kind: 'unavailable' };
    const sourceLength = history.length;
    let attempt: { compactionId: string; started: number; accepted: boolean } | undefined;
    let outcomeChosen = false;
    const requests: DirectCompactionRequest[] = [];
    const failed = async (
      failure: Extract<TurnCompactionEvent, { type: 'compaction_failed' }>['failure'],
    ): Promise<void> => {
      if (!attempt?.accepted || outcomeChosen) return;
      outcomeChosen = true;
      await this.events.publish({
        type: 'compaction_failed',
        compactionId: attempt.compactionId,
        failure,
        durationMs: performance.now() - attempt.started,
        requests,
      });
    };
    const model = this.deps.models.resolve(request.model);
    const control = this;
    // The compactor uses the same boundary for every auxiliary physical request.
    // Summary outputs are not root assistant Items, but usage/terminals are real.
    const summaryModel: Model = {
      ref: model.ref,
      contextWindow: model.contextWindow,
      stream: (summary, signal) =>
        control.#summary(model, summary, history, signal, request.instructions, (record) => requests.push(record)),
      ...(model.compact
        ? {
            compact: async (native: ModelRequest, signal: AbortSignal) => {
              const { request: prepared, modelStep } = await control.#auxiliary(native, history, request.instructions);
              control.budget.dispatched();
              let outcome: DirectCompactionRequest['outcome'] = 'failed';
              try {
                const items = await model.compact!(prepared, signal, () => {
                  control.deps.onTurnBoundary?.({ turnId: control.spec.turnId, kind: 'request_dispatched' });
                });
                await control.events.publish({ type: 'model_response_completed', modelStep, stopReason: 'end_turn' });
                outcome = 'completed';
                return items;
              } finally {
                const record: DirectCompactionRequest = {
                  requestId: `${control.spec.turnId}:model:${modelStep}`,
                  modelStep,
                  model: prepared.model,
                  outcome: signal.aborted ? 'cancelled' : outcome,
                };
                requests.push(record);
                control.budget.record(record);
              }
            },
          }
        : {}),
    };
    let result;
    try {
      result = await compactDirectHistory({
        ...this.deps.compaction,
        contextWindow: this.deps.compaction.contextWindow ?? model.catalogContextWindow,
        request,
        model: summaryModel,
        signal: this.signal,
        ...this.#compactionState,
        lastCompletedInputTokens: this.#lastInputTokens,
        ...(manual ? { manual: true } : {}),
        onStarted: async (evidence) => {
          const started = { compactionId: `compaction_${randomUUID()}`, started: performance.now(), accepted: false };
          attempt = started;
          await this.events.publish(
            { type: 'compaction_started', compactionId: started.compactionId, ...evidence },
            () => {
              started.accepted = true;
            },
          );
        },
      });
      if (result.kind !== 'compacted') {
        if (result.kind === 'blocked') await failed({ kind: 'blocked', reason: result.reason });
        return result;
      }
      // Steering admitted during summaries is newer than the frozen compact input.
      const replacement = [...result.history, ...history.slice(sourceLength)];
      await this.events.publish({
        type: 'history_replaced',
        history: replacement,
        reason: 'compaction',
        ...(attempt ? { compactionId: attempt.compactionId } : {}),
        rearmAtEstimatedTokens: result.rearmAtEstimatedTokens,
        checkpointReceipts: result.checkpointReceipts,
      });
      history.splice(0, history.length, ...replacement);
      this.#compactionState = {
        rearmAtEstimatedTokens: result.rearmAtEstimatedTokens,
        checkpointReceipts: result.checkpointReceipts,
      };
      this.#lastInputTokens = undefined;
      this.#continuity.clear();
      // Success is the accepted replacement, not private summary output. Choose
      // the outcome before publishing so cancellation cannot turn it into failure.
      if (attempt?.accepted) {
        outcomeChosen = true;
        await this.events.publish({
          type: 'compaction_completed',
          compactionId: attempt.compactionId,
          strategy: result.strategy,
          // The accepted replacement can include steering newer than the frozen
          // compactor proposal. Estimate that actual history, not just the plan.
          after: estimateDirectContext(
            { ...request, input: replacement },
            this.deps.compaction.contextWindow ?? model.catalogContextWindow,
          ),
          durationMs: performance.now() - attempt.started,
          requests,
        });
      }
      return result;
    } catch (error) {
      await failed(
        this.signal.aborted
          ? { kind: 'cancelled' }
          : error instanceof CompactionWrapUp
          ? { kind: 'interrupted', reason: 'budget_wrap_up' }
          : error instanceof NativeBudgetExhausted
          ? { kind: 'interrupted', reason: 'budget_exhausted' }
          : { kind: 'failed', error: toModelError(error) },
      );
      // Child wrap-up is a root tools-disabled response, not an internal summary.
      if (error instanceof CompactionWrapUp) return { kind: 'wrap_up' };
      throw error;
    }
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
    // Summary/native compaction is not a root goal/tool execution context.
    return {
      request: this.#withRecovery(
        selfContained({
          ...(surface?.request ?? canonical),
          tools: [],
          instructions: `${
            (surface?.request ?? canonical).instructions
          }\nThis is internal context compaction, not a root response. Output only the requested summary; do not call tools or adjudicate the durable goal.`,
        }),
      ),
      modelStep,
    };
  }

  async *#summary(
    model: Model,
    request: ModelRequest,
    history: Item[],
    signal: AbortSignal,
    preparedInstructions: string,
    onRequest: (record: DirectCompactionRequest) => void,
  ): AsyncGenerator<ModelEvent> {
    const prepared = await this.#auxiliary(request, history, preparedInstructions);
    const requestId = `${this.spec.turnId}:model:${prepared.modelStep}`;
    let usage: Usage | undefined;
    let done: Done | undefined;
    let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
    this.budget.dispatched();
    try {
      for await (const event of model.stream(prepared.request, signal, () => {
        this.deps.onTurnBoundary?.({ turnId: this.spec.turnId, kind: 'request_dispatched' });
      })) {
        if (signal.aborted) throw cancelled();
        if (event.type === 'usage') {
          usage = event.usage;
          await this.events.publish({ type: 'usage', usage, modelStep: prepared.modelStep });
        }
        if (event.type === 'done') {
          done = event;
          await this.events.publish({
            type: 'model_response_completed',
            modelStep: prepared.modelStep,
            stopReason: event.stopReason,
            ...(event.continuation !== undefined ? { continuation: event.continuation } : {}),
            ...(event.providerMetadata !== undefined ? { providerMetadata: event.providerMetadata } : {}),
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
          });
          outcome = 'completed';
        }
        yield event;
      }
    } catch (error) {
      outcome = 'failed';
      throw error;
    } finally {
      const record: DirectCompactionRequest = {
        requestId,
        modelStep: prepared.modelStep,
        model: prepared.request.model,
        ...(usage !== undefined ? { usage } : {}),
        ...(done?.costUsd !== undefined ? { costUsd: done.costUsd } : {}),
        outcome: signal.aborted ? 'cancelled' : outcome,
      };
      onRequest(record);
      this.budget.record({
        ...record,
        serviceTier: prepared.request.useStandardServiceTier ? 'standard' : undefined,
      });
    }
  }

  async #stream(request: ModelRequest, history: Item[], modelStep: number): Promise<{ calls: RootCall[]; done: Done }> {
    this.#requestHasOutput = false;
    const calls: RootCall[] = [];
    const items: Item[] = [];
    let text = '';
    let textPosition = 0;
    let done: Done | undefined;
    let usage: Usage | undefined;
    let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
    try {
      for await (const event of this.deps.models.resolve(request.model).stream(request, this.signal, () => {
        this.deps.onTurnBoundary?.({ turnId: this.spec.turnId, kind: 'request_dispatched' });
      })) {
        if (this.signal.aborted) throw cancelled();
        if (done) throw new Error('Model emitted events after its terminal response');
        switch (event.type) {
          case 'text_delta':
            await this.events.publish({ type: 'text_delta', delta: event.delta, modelStep });
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
            await this.events.publish({ ...event, turnId: this.spec.turnId, modelStep });
            // Progress already shown to the caller is physical output evidence,
            // even though it is not a completed/admitted tool or history item.
            this.#hasOutput = true;
            this.#requestHasOutput = true;
            break;
          case 'item': {
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
          case 'usage':
            usage = event.usage;
            await this.events.publish({ type: 'usage', usage, modelStep });
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
      if (!done) throw new Error('Model stream ended before the response completed.');
      outcome = 'completed';
      this.#lastInputTokens = usage?.inputTokens;
      return { calls, done };
    } finally {
      if (text)
        items.splice(textPosition, 0, {
          type: 'assistant_message',
          id: `${this.spec.turnId}-model-${modelStep}-partial` as ItemId,
          content: [{ type: 'text', text }],
        });
      // Every retained item/delta already has its own durable Session receipt.
      history.push(...items);
      this.budget.record({
        requestId: `${this.spec.turnId}:model:${modelStep}`,
        model: request.model,
        serviceTier: request.useStandardServiceTier ? 'standard' : undefined,
        usage,
        costUsd: done?.costUsd,
        outcome: this.signal.aborted ? 'cancelled' : outcome,
      });
    }
  }
}

/** Consume live adapter cause/evidence before the serializable error projection. */
function recoveryFailure(error: unknown): DirectRecoveryFailure {
  const live = error as { cause?: unknown; recoveryEvidence?: DirectRecoveryFailure['evidence'] } | null;
  return { error: toModelError(error), cause: live?.cause, evidence: live?.recoveryEvidence };
}

/** Error.message is non-enumerable; raw causes and provider frames never persist. */
export function toModelError(error: unknown): ModelError {
  const { kind, message, retryable, retryAfterMs } = (error ?? {}) as Partial<ModelError>;
  if (typeof kind === 'string' && typeof message === 'string')
    return {
      kind,
      message,
      retryable: retryable === true,
      ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
    };
  return { kind: 'provider', message: error instanceof Error ? error.message : String(error), retryable: false };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(cancelled());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
