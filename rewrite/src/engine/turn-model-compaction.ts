/** Compaction proposal and summary lifecycle; TurnModel retains root request recovery. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Item, Model, ModelError, ModelEvent, ModelRequest, Usage } from '../model/index.js';
import type { DirectCompactionResult, DirectCompactionRequest } from './direct-recovery-compaction.js';
import { compactDirectHistory, estimateDirectContext } from './direct-recovery-compaction.js';
import type { DirectManualCompactionOutcome, TurnCompactionEvent, TurnDeps, TurnSpec } from './direct-types.js';
import { NativeBudgetExhausted, type TurnBudgetControl } from './turn-budget.js';
import { TurnEvents, cancelled } from './turn-events.js';

type Done = Extract<ModelEvent, { type: 'done' }>;
export class CompactionWrapUp extends Error {}
export type CompactionAttemptResult = DirectCompactionResult | { readonly kind: 'unavailable' | 'wrap_up' };

/** Owns private summary work and accepts only a durable history replacement. */
export class TurnCompaction {
  #state: TurnSpec['compactionState'];
  #lastInputTokens: number | undefined;
  #blockedUntilEstimatedTokens: number | undefined;

  constructor(
    readonly spec: TurnSpec,
    readonly deps: TurnDeps,
    readonly signal: AbortSignal,
    readonly events: TurnEvents,
    readonly budget: TurnBudgetControl,
    readonly prepareAuxiliary: (
      request: ModelRequest,
      history: Item[],
      preparedInstructions: string,
    ) => Promise<{ request: ModelRequest; modelStep: number }>,
    readonly acceptedReplacement: () => void,
  ) {
    this.#state = spec.compactionState;
  }

  recordInputTokens(inputTokens: number | undefined): void {
    this.#lastInputTokens = inputTokens;
  }

  async compact(request: ModelRequest, history: Item[], manual = false): Promise<CompactionAttemptResult> {
    if (!this.deps.compaction) return { kind: 'unavailable' };
    if (!manual && this.#blockedUntilEstimatedTokens !== undefined) {
      const estimate = estimateDirectContext(request);
      if (estimate.renderedInputTokens < this.#blockedUntilEstimatedTokens) {
        return { kind: 'deferred', reason: 'hysteresis', estimate };
      }
    }
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
    const summaryModel: Model = {
      ref: model.ref,
      contextWindow: model.contextWindow,
      stream: (summary, signal) =>
        this.#summary(model, summary, history, signal, request.instructions, (record) => requests.push(record)),
      ...(model.compact
        ? {
            compact: async (native: ModelRequest, signal: AbortSignal) => {
              const { request: prepared, modelStep } = await this.prepareAuxiliary(
                native,
                history,
                request.instructions,
              );
              this.budget.dispatched();
              let outcome: DirectCompactionRequest['outcome'] = 'failed';
              try {
                const items = await model.compact!(prepared, signal, () => {
                  this.deps.onTurnBoundary?.({ turnId: this.spec.turnId, kind: 'request_dispatched' });
                });
                await this.events.publish({ type: 'model_response_completed', modelStep, stopReason: 'end_turn' });
                outcome = 'completed';
                return items;
              } finally {
                const record: DirectCompactionRequest = {
                  requestId: `${this.spec.turnId}:model:${modelStep}`,
                  modelStep,
                  model: prepared.model,
                  outcome: signal.aborted ? 'cancelled' : outcome,
                };
                requests.push(record);
                this.budget.record(record);
              }
            },
          }
        : {}),
    };
    try {
      const result = await compactDirectHistory({
        ...this.deps.compaction,
        contextWindow: this.deps.compaction.contextWindow ?? model.catalogContextWindow,
        request,
        model: summaryModel,
        signal: this.signal,
        ...this.#state,
        lastCompletedInputTokens: this.#lastInputTokens,
        ...(manual ? { manual: true } : {}),
        onStarted: async (evidence) => {
          const started = {
            compactionId: `compaction_${randomUUID()}`,
            started: performance.now(),
            accepted: false,
          };
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
        if (result.kind === 'blocked') {
          await failed({ kind: 'blocked', reason: result.reason });
          if (!manual && attempt?.accepted) {
            if (result.reason === 'non_reducing' || result.reason === 'result_still_too_large') {
              throw new Error(
                `Automatic context compaction could not make enough room (${result.reason}); use /compact or start a new conversation.`,
              );
            }
            const measured = Math.max(result.estimate.renderedInputTokens, this.#lastInputTokens ?? 0);
            this.#blockedUntilEstimatedTokens =
              result.estimate.renderedInputTokens +
              Math.max(1_000, Math.ceil(result.estimate.renderedInputTokens * 0.1));
            this.#state = {
              ...this.#state,
              rearmAtEstimatedTokens: measured + Math.max(1_000, Math.ceil(measured * 0.1)),
            };
          }
        }
        return result;
      }
      const replacement = [...result.history, ...history.slice(sourceLength)];
      await this.events.publish({
        type: 'history_replaced',
        history: replacement,
        reason: 'compaction',
        ...(attempt ? { compactionId: attempt.compactionId } : {}),
        ...(result.rearmAtEstimatedTokens === undefined
          ? {}
          : { rearmAtEstimatedTokens: result.rearmAtEstimatedTokens }),
        checkpointReceipts: result.checkpointReceipts,
      });
      history.splice(0, history.length, ...replacement);
      this.#state = {
        ...(result.rearmAtEstimatedTokens === undefined
          ? {}
          : { rearmAtEstimatedTokens: result.rearmAtEstimatedTokens }),
        checkpointReceipts: result.checkpointReceipts,
      };
      this.#lastInputTokens = undefined;
      this.#blockedUntilEstimatedTokens = undefined;
      this.acceptedReplacement();
      if (attempt?.accepted) {
        outcomeChosen = true;
        await this.events.publish({
          type: 'compaction_completed',
          compactionId: attempt.compactionId,
          strategy: result.strategy,
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
      if (error instanceof CompactionWrapUp) return { kind: 'wrap_up' };
      throw error;
    }
  }

  async *#summary(
    model: Model,
    request: ModelRequest,
    history: Item[],
    signal: AbortSignal,
    preparedInstructions: string,
    onRequest: (record: DirectCompactionRequest) => void,
  ): AsyncGenerator<ModelEvent> {
    const prepared = await this.prepareAuxiliary(request, history, preparedInstructions);
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
}

function toModelError(error: unknown): ModelError {
  const { kind, message, retryable, retryAfterMs } = (error ?? {}) as Partial<ModelError>;
  if (typeof kind === 'string' && typeof message === 'string')
    return {
      kind,
      message,
      retryable: retryable === true,
      ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
    };
  return {
    kind: 'provider',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
