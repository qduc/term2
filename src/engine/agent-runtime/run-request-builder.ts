import { getCatalogModel } from '../../model/providers/model-catalog/catalog.js';
import { projectModelRequestHistory } from '../../model/history-projection.js';
import type {
  ContextCompactionSessionState,
  StreamedModelTurnInput,
  StreamedModelTurnRequest,
} from '../../model/streamed-model-turn.js';
import { type ModelRequestCost } from '../../shared/cost/model-cost.js';
import { MaxTurnsExceededError } from '../../tools/subagents/max-turns-error.js';
import { type AgentStream } from '../agent-stream.js';
import { GenerationGuard } from './generation-guard.js';
import { resolveRequestOutput } from './model-context-policy.js';
import { enforceRequestInputLimit } from './request-input-limit.js';
import { appendCostRecord, nextRequestId, resolveServiceTier } from './run-cost-records.js';
import { mergeChainedCompactionHistory, normalizeApplicationInput, toModelTools } from './run-input.js';
import { EventQueue, outputPush } from './run-segment-events.js';
import type { RunContext, RunState } from './run-state.js';
/** A built attempt keeps admission inside request-preparation context and exposes exact abort cleanup. */
export interface ReadyModelRequest {
  request: StreamedModelTurnRequest;
  requestId: string;
  criticalWrapUp: boolean;
  generationGuard: GenerationGuard;
  abort(): void;
  dispose(): void;
  dispatch(consume: () => Promise<void>): Promise<void>;
  recordFailure(outcome: 'failed' | 'cancelled'): ModelRequestCost;
}
/** Owns request-boundary compaction/accounting and provider request construction, never model dispatch. */
export class RunRequestBuilder {
  constructor(
    private readonly contextCompactionSessionState: ContextCompactionSessionState,
    private readonly admit: (state: RunState, stream: AgentStream, queue: EventQueue) => void,
    private readonly evaluate: (state: RunState, stream: AgentStream, queue: EventQueue) => void,
    private readonly waitForBudget: (context: RunContext) => Promise<boolean>,
    private readonly notice: (text: string) => void,
  ) {}
  /** Admit input and prepare context once for the next logical model round. */
  async prepareBoundary(context: RunContext): Promise<boolean> {
    let { state, stream, queue, options } = context;
    // The request boundary: every tool result of the previous round is in
    // history, and the next request has not been built. A user message
    // admitted here reaches the model in sequence, mid-turn.
    this.admit(state, stream, queue);
    this.evaluate(state, stream, queue);
    if (await this.waitForBudget(context)) return true;
    ({ state, stream, queue, options } = context);
    const compactionHistoryResult = state.usesDeltaHistory
      ? state.compactionHistory
        ? mergeChainedCompactionHistory(state.compactionHistory, state.history)
        : { kind: 'skipped' as const, reason: 'missing_snapshot' as const }
      : { kind: 'ready' as const, history: state.history };
    const boundaryDecision = options.onRequestBoundary?.(
      compactionHistoryResult.kind === 'ready' ? compactionHistoryResult.history : state.history,
      (text) => this.notice(text),
      {
        ...(state.lastCompletedInputTokens !== undefined
          ? { lastCompletedInputTokens: state.lastCompletedInputTokens }
          : {}),
        ...(compactionHistoryResult.kind === 'skipped' ? { compactionSkipReason: compactionHistoryResult.reason } : {}),
      },
    );

    const compactionHistory = compactionHistoryResult.kind === 'ready' ? compactionHistoryResult.history : undefined;
    if (options.boundaryCompaction && compactionHistory && !boundaryDecision?.deferCompaction) {
      const compactionStartedAt = Date.now();
      let costsRecordedLive = false;
      const compaction = await options.boundaryCompaction.compact({
        history: compactionHistory,
        instructions: state.agent.resolveInstructionsForRequest?.() ?? state.agent.instructions,
        tools: toModelTools(state.agent.tools),
        recordCostRecords: (records) => {
          if (records.length) {
            costsRecordedLive = true;
            state.costRecords ??= [];
            state.costRecords.push(...records);
            for (const record of records) queue.push({ type: 'cost_update', record });
            this.evaluate(state, stream, queue);
          }
          return !state.pendingRunBudgetInteraction && !state.criticalWrapUpPending;
        },
        automaticCompactionsThisRun: state.automaticCompactionsThisRun ?? 0,
        lastCompletedInputTokens: state.lastCompletedInputTokens,
        signal: options.signal,
        onStarted: (provider) =>
          outputPush(stream, queue, { type: 'context_compaction_started', provider, strategy: 'local' }),
      });
      if (compaction.kind !== 'unchanged' && !costsRecordedLive && compaction.costRecords?.length) {
        state.costRecords ??= [];
        state.costRecords.push(...compaction.costRecords);
      }
      if (compaction.kind === 'compacted') {
        state.inputUsageInvalidatedByCompaction = true;
        state.lastCompletedInputTokens = undefined;
        state.compactedDuringRun = true;
        state.history.splice(0, state.history.length, ...compaction.history);
        state.input.splice(0, state.input.length, ...normalizeApplicationInput(compaction.modelInput));
        state.responseId = undefined;
        state.responseProviderId = undefined;
        state.usesDeltaHistory = false;
        state.automaticCompactionsThisRun = (state.automaticCompactionsThisRun ?? 0) + 1;
        outputPush(stream, queue, {
          type: 'context_compaction_completed',
          provider: state.currentProviderId ?? 'unknown',
          strategy: 'local',
          durationMs: Math.max(0, Date.now() - compactionStartedAt),
        });
      } else if (compaction.kind === 'failed') {
        outputPush(stream, queue, {
          type: 'context_compaction_failed',
          provider: compaction.provider,
          strategy: 'local',
          durationMs: Math.max(0, Date.now() - compactionStartedAt),
        });
        if (compaction.error) throw compaction.error;
      } else if (compaction.notice && compaction.notice !== state.compactionNotice) {
        state.compactionNotice = compaction.notice;
        this.notice(compaction.notice);
      }

      // Summarization is an asynchronous part of this same request
      // boundary. Admit anything that arrived while it was in flight after
      // applying a replacement, so the steer cannot be overwritten by the
      // checkpoint or miss a terminal model request.
      this.admit(state, stream, queue);
      this.evaluate(state, stream, queue);
      if (await this.waitForBudget(context)) return true;
      ({ state, stream, queue, options } = context);
    }

    this.admit(state, stream, queue);

    state.turnCount += 1;
    this.evaluate(state, stream, queue);
    if (await this.waitForBudget(context)) return true;
    ({ state, stream, queue, options } = context);
    // Retain the legacy error only for callers that have not adopted staged
    // budgets. A configured run budget turns the same count into critical
    // evidence and lets the decision surface choose what happens next.
    if (!state.runBudget && state.maxTurns !== undefined && state.turnCount > state.maxTurns) {
      throw new MaxTurnsExceededError(state.maxTurns);
    }

    return false;
  }

  /** Build one attempt; retries rebuild snapshots without recounting the logical request boundary. */
  build(context: RunContext): ReadyModelRequest {
    const { state, options } = context;
    const requestId = nextRequestId();
    const criticalWrapUp = state.criticalWrapUpPending === true && state.criticalWrapUpDispatched !== true;
    if (criticalWrapUp) state.criticalWrapUpDispatched = true;
    const disableChaining = state.disableChainingForAttempt === true;
    if (disableChaining) {
      state.disableChainingForAttempt = false;
      state.responseId = undefined;
      state.responseProviderId = undefined;
    }
    // A per-request signal lets a recoverable guard trip cancel only this
    // provider request; the segment signal still cancels everything.
    const requestSignal = new AbortController();
    const abortRequest = (): void => requestSignal.abort();
    if (options.signal?.aborted) requestSignal.abort();
    else options.signal?.addEventListener('abort', abortRequest, { once: true });
    const requestInstructions = state.agent.resolveInstructionsForRequest?.() ?? state.agent.instructions;
    // Same synchronous step as the instructions above, so the snapshot is
    // exactly the state the model is shown in this request.
    state.requestSnapshot = state.agent.resolveRequestSnapshot?.();
    const requestCatalog = getCatalogModel(state.currentProviderId ?? 'openai', state.agent.model);
    const effectiveOutput = resolveRequestOutput(requestCatalog, state.agent.modelSettings?.maxTokens);
    const request: StreamedModelTurnRequest = {
      instructions: criticalWrapUp
        ? `${requestInstructions}\n\nBudget containment is terminal. Do not call tools. In this one final response, summarize what you completed, the evidence you have, and what remains.`
        : requestInstructions,
      ...(state.supportsConversationChaining &&
      !disableChaining &&
      state.responseId &&
      state.responseProviderId !== undefined &&
      state.responseProviderId === state.currentProviderId
        ? { previousResponseId: state.responseId }
        : {}),
      ...(disableChaining ? { disableChaining: true } : {}),
      input: projectModelRequestHistory(state.input) as StreamedModelTurnInput[],
      tools: toModelTools(criticalWrapUp ? [] : state.agent.tools),
      applicationTools: criticalWrapUp ? [] : state.agent.tools,
      ...(state.agent.modelSettings?.temperature !== undefined
        ? { temperature: state.agent.modelSettings.temperature as number }
        : {}),
      ...(state.agent.modelSettings?.reasoning ? { reasoning: state.agent.modelSettings.reasoning as any } : {}),
      ...(effectiveOutput !== undefined ? { maxTokens: effectiveOutput } : {}),
      ...(state.agent.outputType !== undefined ? { outputType: state.agent.outputType } : {}),
      ...(state.agent.modelSettings?.codex ? { codex: state.agent.modelSettings.codex } : {}),
      ...(state.agent.modelSettings?.providerData
        ? {
            providerOptions: this.contextCompactionSessionState.disabled
              ? Object.fromEntries(
                  Object.entries(state.agent.modelSettings.providerData).filter(([key]) => key !== 'contextCompaction'),
                )
              : state.agent.modelSettings.providerData,
          }
        : {}),
      signal: requestSignal.signal,
      ...(state.recoveryBudget ? { recoveryBudget: state.recoveryBudget } : {}),
    };
    const generationGuard = new GenerationGuard({
      maxOutputCharacters: state.agent.modelSettings?.maxStreamOutputChars,
      maxTextCharacters: state.agent.modelSettings?.maxStreamOutputChars,
      maxReasoningCharacters: state.agent.modelSettings?.maxStreamOutputChars,
      maxToolArgumentCharacters: state.agent.modelSettings?.maxStreamOutputChars,
      maxCumulativeToolArgumentCharacters: state.agent.modelSettings?.maxStreamOutputChars,
      requestDeadlineMs: state.agent.modelSettings?.maxModelRequestDurationMs,
      maxStreamIdleMs: state.agent.modelSettings?.maxModelStreamIdleMs,
      ...options.generationGuard,
    });

    return {
      request,
      requestId,
      criticalWrapUp,
      generationGuard,
      abort: () => requestSignal.abort(),
      dispose: () => options.signal?.removeEventListener('abort', abortRequest),
      dispatch: async (consume) => {
        const dispatch = async () => {
          state.requestPreparation?.prepare(request);
          // A response ID can be established after a self-contained request.
          // It does not make this run's full history a delta needing a snapshot.
          const needsChainedSnapshot = Boolean(request.previousResponseId && state.usesDeltaHistory);
          const fullContext =
            needsChainedSnapshot && state.compactionHistory
              ? mergeChainedCompactionHistory(state.compactionHistory, state.history)
              : undefined;
          const contextCatalog = getCatalogModel(state.currentProviderId ?? 'openai', state.agent.model);
          enforceRequestInputLimit({
            contextWindow: contextCatalog?.contextWindow,
            maxOutputTokens: request.maxTokens,
            limit: state.requestInputLimit
              ? state.requestInputLimit()
              : state.agent.modelSettings?.maxRequestInputTokens,
            history:
              fullContext?.kind === 'ready'
                ? fullContext.history
                : needsChainedSnapshot
                ? [...(state.compactionHistory ?? []), ...request.input]
                : request.input,
            instructions: request.instructions ?? '',
            tools: request.tools,
            lastCompletedInputTokens: state.inputUsageInvalidatedByCompaction
              ? undefined
              : state.lastCompletedInputTokens,
            chainedContextKnown: !needsChainedSnapshot || fullContext?.kind === 'ready',
          });

          await consume();
        };
        if (state.requestPreparation) await state.requestPreparation.run(dispatch);
        else await dispatch();
      },
      recordFailure: (outcome) =>
        appendCostRecord(state, {
          requestId,
          provider: state.currentProviderId,
          model: state.agent.model,
          tier: resolveServiceTier(request),
          outcome,
        }),
    };
  }
}
