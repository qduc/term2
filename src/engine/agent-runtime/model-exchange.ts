import { waitForAbortableRead } from '../../shared/contracts/abort-aware-wait.js';
import type { StreamedModelTurnEvent, StreamedModelTurnRequest } from '../../model/streamed-model-turn.js';
import { ASSISTANT_TEXT_PART_SEPARATOR } from '../../model/streamed-model-turn.js';
import { type ServiceTier } from '../../shared/cost/model-cost.js';
import { describeError } from '../../model/error-helpers.js';
import { type AgentStream } from '../agent-stream.js';
import { buildFailureObservation } from '../decision-shadow/failure-observation.js';
import { classifyInLoopModelRetry, sleepWithAbort } from '../retry/in-loop-model-retry.js';
import {
  DEFAULT_TOOL_ARGUMENT_RUNAWAY_SIGNATURE,
  GenerationGuardError,
  GenerationStreamDeadlines,
  ToolArgumentRunawayGuard,
} from './generation-guard.js';
import {
  ProviderContextOverflowError,
  RequestInputLimitError,
  isProviderContextOverflow,
} from './request-input-limit.js';
import { evaluateRunBudget } from './run-budget-policy.js';
import { resolveServiceTier } from './run-cost-records.js';
import type { ApplicationRunLoopDeps } from './run-loop-contracts.js';
import { appendNativeReasoning, type PendingNativeReasoning } from './run-native-reasoning.js';
import type { ReadyModelRequest } from './run-request-builder.js';
import { EventQueue, outputPush } from './run-segment-events.js';
import type { ModelExchange, RunContext, RunState } from './run-state.js';
/** Owns provider dispatch, stream guards and retry rollback; it never executes a tool. */
export class ModelExchangeRequest {
  readonly #deps: ApplicationRunLoopDeps;
  constructor(
    deps: ApplicationRunLoopDeps,
    private readonly notice: (text: string) => void,
    private readonly admit: (state: RunState, stream: AgentStream, queue: EventQueue) => void,
  ) {
    this.#deps = deps;
  }
  #observeTerminalFailure(
    error: unknown,
    request: { requestId: string; provider?: string; model: string; tier: ServiceTier },
  ): void {
    this.#observeDecisionShadow('failure_triage', () => {
      this.#deps.decisionShadowObserver?.observeTerminalFailure(buildFailureObservation(error, request));
    });
  }

  #observeDecisionShadow(kind: string, observe: () => void): void {
    if (!this.#deps.decisionShadowObserver) return;
    try {
      observe();
    } catch (error) {
      try {
        this.#deps.logDiagnostic?.(
          'Decision shadow observer failed synchronously',
          { kind, error: error instanceof Error ? error.message : String(error) },
          { severity: 'debug', eventType: 'decision_shadow.observer_failed' },
        );
      } catch {
        // Observation and its diagnostics must never affect the run.
      }
    }
  }
  /** Own streaming and safe request attempts; never dispatch tools here. */
  async askModel(context: RunContext, build: () => ReadyModelRequest): Promise<ModelExchange> {
    const { state, stream, queue, options, requestAbortController } = context;
    const resolution = Promise.resolve(this.#deps.resolveModel(state.agent.model));
    const model =
      (context.session?.abortPendingModelReads || this.#deps.abortPendingModelReads) && options.signal
        ? await waitForAbortableRead(
            resolution,
            options.signal,
            context.session?.onDetachedModelRead ?? this.#deps.onDetachedModelRead,
          )
        : await resolution;
    const maxRetries = state.agent.modelSettings?.retry?.maxRetries ?? 0;
    let attempt = 0;
    let streamedToolCalls: Array<Extract<StreamedModelTurnEvent, { type: 'tool_call' }>> = [];
    let completion: Extract<StreamedModelTurnEvent, { type: 'completion' }> | undefined;
    let sawToolCall = false;
    let activeRequestId = '';
    let activeRequest: StreamedModelTurnRequest | undefined;
    let pendingNativeReasoning: PendingNativeReasoning | undefined;
    let deferredNativeReasoning: PendingNativeReasoning[] = [];
    let criticalWrapUp = false;

    while (true) {
      streamedToolCalls = [];
      completion = undefined;
      sawToolCall = false;
      pendingNativeReasoning = undefined;
      deferredNativeReasoning = [];
      // Stable process-unique request id, allocated immediately before dispatch
      // so a cost record can be settled exactly once (success or failure).

      const outputLengthBefore = stream.output.length;
      const newItemsLengthBefore = stream.newItems.length;
      const inputLengthBefore = state.input.length;
      const historyLengthBefore = state.history.length;
      const criticalWrapUpDispatchedBefore = state.criticalWrapUpDispatched;
      let provisionalTextCharacters = 0;
      let provisionalReasoningCharacters = 0;
      let provisionalTextDeltas = 0;
      let provisionalReasoningDeltas = 0;
      let lastTextPartId: string | undefined;

      const ready = build();
      const { request, requestId, generationGuard } = ready;
      activeRequestId = requestId;
      activeRequest = request;
      criticalWrapUp = ready.criticalWrapUp;
      const consume = async (): Promise<void> => {
        const deadline = new GenerationStreamDeadlines(
          { totalMs: generationGuard.requestDeadlineMs, idleMs: generationGuard.maxStreamIdleMs },
          () => requestAbortController.abort(),
          () => generationGuard.progress,
        );
        const toolArgumentRunaway = isLunaChainedRequest(state, request)
          ? new ToolArgumentRunawayGuard(
              {
                ...DEFAULT_TOOL_ARGUMENT_RUNAWAY_SIGNATURE,
                timeoutMs: generationGuard.toolArgumentRunawayMs,
              },
              () => requestAbortController.abort(),
            )
          : undefined;
        let iterator: AsyncIterator<StreamedModelTurnEvent> | undefined;
        let iteratorFinished = false;
        try {
          options.signal?.throwIfAborted();
          context.session?.onModelDispatch?.({
            requestId,
            providerId: state.currentProviderId,
            model: state.agent.model,
          });
          iterator = model.stream(request)[Symbol.asyncIterator]();
          while (true) {
            const read = iterator.next();
            const abortReads = context.session?.abortPendingModelReads || this.#deps.abortPendingModelReads;
            const detached = context.session?.onDetachedModelRead ?? this.#deps.onDetachedModelRead;
            const nextOperation =
              abortReads && options.signal ? waitForAbortableRead(read, options.signal, detached) : read;
            const next = await deadline.wait(
              toolArgumentRunaway ? toolArgumentRunaway.wait(nextOperation) : nextOperation,
            );
            if (next.done) {
              iteratorFinished = true;
              return;
            }
            // Any streamed event is transport activity: re-arm the inactivity
            // window so long legitimate reasoning is never mistaken for a stall.
            deadline.recordActivity();
            const event = next.value;
            if (event.type === 'completion') {
              toolArgumentRunaway?.observeToolCallCompleted();
              generationGuard.observeCompletion(event.output);
              completion = event;
              continue;
            }
            if (event.type === 'text_delta') {
              const startsNewPart =
                event.partId !== undefined &&
                lastTextPartId !== undefined &&
                event.partId !== lastTextPartId &&
                event.text.length > 0;
              if (event.partId !== undefined && event.text.length > 0) lastTextPartId = event.partId;
              const text = startsNewPart ? `${ASSISTANT_TEXT_PART_SEPARATOR}${event.text}` : event.text;
              toolArgumentRunaway?.observeText();
              generationGuard.observeText(text);
              provisionalTextCharacters += text.length;
              provisionalTextDeltas++;
              outputPush(stream, queue, { type: 'text_delta', text });
              continue;
            }
            if (event.type === 'codex_rate_limits') {
              outputPush(stream, queue, { type: 'codex_rate_limits', rateLimits: event.rateLimits });
              continue;
            }
            if (event.type === 'reasoning_started') {
              outputPush(stream, queue, {
                type: 'reasoning_started',
                ...(event.id !== undefined ? { id: event.id } : {}),
              });
              continue;
            }
            if (event.type === 'reasoning_delta') {
              const accepted = generationGuard.observeReasoning(event.text);
              if (!accepted) continue;
              const forwarded = accepted === event.text ? event : { ...event, text: accepted };
              pendingNativeReasoning = appendNativeReasoning(pendingNativeReasoning, forwarded);
              provisionalReasoningCharacters += accepted.length;
              provisionalReasoningDeltas++;
              outputPush(stream, queue, { type: 'reasoning_delta', text: accepted });
              continue;
            }
            if (event.type === 'tool_call_streaming_delta') {
              toolArgumentRunaway?.observeToolArgumentProgress(event.argumentCharCount);
              generationGuard.observeToolArgumentProgress(event.argumentCharCount);
              outputPush(stream, queue, event);
              continue;
            }
            if (event.type === 'context_compaction_started' || event.type === 'context_compaction_completed') {
              outputPush(stream, queue, event);
              continue;
            }
            if (event.type === 'tool_call') {
              toolArgumentRunaway?.observeToolCallCompleted();
              generationGuard.observeToolCall(event.arguments);
              // The authoritative completion may introduce a native
              // replacement boundary before this call's reasoning.
              if (pendingNativeReasoning) deferredNativeReasoning.push(pendingNativeReasoning);
              pendingNativeReasoning = undefined;
              sawToolCall = true;
              streamedToolCalls.push(event);
            }
          }
        } finally {
          deadline.dispose();
          toolArgumentRunaway?.dispose();
          if (iterator && !iteratorFinished) {
            if (context.session?.abortPendingModelReads || this.#deps.abortPendingModelReads) {
              try {
                const returned = iterator.return?.();
                if (returned) {
                  const operation = Promise.resolve(returned);
                  if (options.signal?.aborted)
                    (context.session?.onDetachedModelRead ?? this.#deps.onDetachedModelRead)?.(operation);
                  void operation.catch(() => undefined);
                }
              } catch {
                /* Best-effort late iterator cleanup. */
              }
            } else void iterator.return?.().catch(() => undefined);
          }
        }
      };

      try {
        await ready.dispatch(consume);
        break;
      } catch (error) {
        if (error instanceof RequestInputLimitError) {
          this.#deps.logDiagnostic?.('Request input admission refused', {
            code: error.code,
            action: error.action,
            reason: error.reason,
            guardClass: 'admission',
            setting: 'agent.maxRequestInputTokens',
            executionScope: state.hookScope ?? 'root',
            recovery: 'retained_work',
            limit: error.limit,
            estimatedTokens: error.estimatedTokens,
            observedTokens: error.observedTokens,
            capacity: error.capacity,
            outputReserve: error.outputReserve,
            estimationReserve: error.estimationReserve,
          });
          throw error;
        }
        if (isProviderContextOverflow(error)) {
          this.#observeTerminalFailure(error, {
            requestId: activeRequestId,
            provider: state.currentProviderId,
            model: state.agent.model,
            tier: resolveServiceTier(request),
          });
          throw new ProviderContextOverflowError(error);
        }
        const recoverOversizedToolArgument =
          isOversizedToolArgumentTrip(error) &&
          (state.oversizedToolArgumentRecoveries ?? 0) < MAX_OVERSIZED_TOOL_ARGUMENT_RECOVERIES &&
          !options.signal?.aborted;
        if (recoverOversizedToolArgument) ready.abort();
        else if (error instanceof GenerationGuardError) requestAbortController.abort();

        const decision = classifyInLoopModelRetry(error, attempt, maxRetries, Math.random, {
          previousResponseId: activeRequest?.previousResponseId,
        });
        const rollbackProvisionalAttempt = (): void => {
          stream.output.splice(outputLengthBefore);
          if (stream.newItems !== stream.output) {
            stream.newItems.splice(newItemsLengthBefore);
          }
          if (provisionalTextDeltas > 0 || provisionalReasoningDeltas > 0) {
            queue.push({
              type: 'model_attempt_rollback',
              textCharacters: provisionalTextCharacters,
              reasoningCharacters: provisionalReasoningCharacters,
              textDeltas: provisionalTextDeltas,
              reasoningDeltas: provisionalReasoningDeltas,
            });
          }
        };

        if (recoverOversizedToolArgument) {
          // No tool ran: a call is dispatched only after its arguments
          // complete. Discard the partial response and ask for smaller calls.
          state.oversizedToolArgumentRecoveries = (state.oversizedToolArgumentRecoveries ?? 0) + 1;
          state.input.splice(inputLengthBefore);
          state.history.splice(historyLengthBefore);
          state.criticalWrapUpDispatched = criticalWrapUpDispatchedBefore;
          rollbackProvisionalAttempt();
          this.#deps.logDiagnostic?.('Recovering oversized tool argument in run loop', {
            code: (error as GenerationGuardError).code,
            recovery: state.oversizedToolArgumentRecoveries,
            maxRecoveries: MAX_OVERSIZED_TOOL_ARGUMENT_RECOVERIES,
          });
          this.notice(oversizedToolArgumentNotice((error as GenerationGuardError).message));
          this.admit(state, stream, queue);
          continue;
        }

        if (decision.retryable && !options.signal?.aborted) {
          attempt++;
          state.input.splice(inputLengthBefore);
          state.history.splice(historyLengthBefore);
          state.criticalWrapUpDispatched = criticalWrapUpDispatchedBefore;
          rollbackProvisionalAttempt();
          if (decision.kind === 'chain_recovery') {
            state.disableChainingForAttempt = true;
            state.responseId = undefined;
            state.responseProviderId = undefined;
          }
          this.#deps.logDiagnostic?.('Retrying model request in run loop', {
            attempt,
            maxRetries,
            kind: decision.kind,
            delayMs: decision.delayMs,
            error: describeError(error),
          });
          await (this.#deps.waitBeforeModelRetry ?? sleepWithAbort)(decision.delayMs, options.signal);
          continue;
        }

        // Session recovery owns full-history rebuild for a chained delta.
        // Retract this cycle's provisional tokens so a later chain_recovery
        // does not append a second answer after a half-sentence.
        if (!decision.retryable && decision.reason === 'chained_delta_not_self_contained') {
          rollbackProvisionalAttempt();
        }

        // Dispatch began, but no terminal completion was accepted. Record an
        // unpriced marker so the summary stays honest (partial) rather than
        // appearing exact. Observational only: the error still propagates.
        const cancelled = error instanceof Error && error.name === 'AbortError';
        const record = ready.recordFailure(cancelled ? 'cancelled' : 'failed');
        // Only the live queue sees cost records: `output`/`newItems` feed
        // persistence and replay, and a cost event must never become a
        // restored history item.
        queue.push({ type: 'cost_update', record });
        evaluateRunBudget(state, stream, queue, this.#deps.logDiagnostic);
        this.#observeTerminalFailure(error, {
          requestId,
          provider: state.currentProviderId,
          model: state.agent.model,
          tier: resolveServiceTier(request),
        });
        throw error;
      } finally {
        ready.dispose();
      }
    }

    return {
      streamedToolCalls,
      completion,
      sawToolCall,
      activeRequestId,
      activeRequest,
      pendingNativeReasoning,
      deferredNativeReasoning,
      criticalWrapUp,
    };
  }
}
function isLunaChainedRequest(state: RunState, request: StreamedModelTurnRequest): boolean {
  return (
    state.currentProviderId === 'codex' &&
    state.agent.model === 'gpt-5.6-luna' &&
    typeof request.previousResponseId === 'string' &&
    request.previousResponseId.length > 0 &&
    request.input.length === 1 &&
    request.input[0]?.type === 'tool_result'
  );
}
/**
 * A legitimate but oversized tool call (usually one large edit) trips the
 * tool-argument caps. Unlike runaway output it is answerable: tell the model
 * the call never ran and let it split the work, a bounded number of times.
 */
const MAX_OVERSIZED_TOOL_ARGUMENT_RECOVERIES = 2;

function isOversizedToolArgumentTrip(error: unknown): error is GenerationGuardError {
  return (
    error instanceof GenerationGuardError &&
    (error.code === 'tool_argument_characters' || error.code === 'cumulative_tool_argument_characters')
  );
}

function oversizedToolArgumentNotice(guardMessage: string): string {
  return (
    `Your previous response was discarded and its tool call was not executed. ${guardMessage} ` +
    'Redo the work in smaller tool calls, each well under that limit — for example, several targeted ' +
    'patches instead of rewriting a whole file in one call.'
  );
}
