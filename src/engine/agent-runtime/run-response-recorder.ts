import { extractAiSdkUpstreamProvider } from '../../model/providers/ai-sdk-streamed-model.js';
import { isOpenAICompaction } from '../../model/history-projection.js';
import type { ProviderInputItem } from '../../shared/contracts/provider-input.js';
import type {
  StreamedModelToolResultPart,
  StreamedModelTurnEvent,
  StreamedModelTurnOutput,
} from '../../shared/contracts/streamed-model-turn.js';
import { ASSISTANT_TEXT_PART_SEPARATOR } from '../../shared/contracts/streamed-model-turn.js';
import { type ServiceTier } from '../../shared/cost/model-cost.js';
import { addTokenUsage } from '../../shared/utils/ai/token-usage.js';
import { getRunCodeExecutionResult, runCodeExecutionMetadata } from '../../tools/system/run-code/run-code-execution.js';
import type { AnyToolDefinition } from '../../tools/types.js';
import { type AgentStream } from '../agent-stream.js';
import { buildFailureObservation } from '../decision-shadow/failure-observation.js';
import { emitRunBudgetEvent, evaluateRunBudget } from './run-budget-policy.js';
import { appendCostRecord, normalizeModelUsage, resolveServiceTier } from './run-cost-records.js';
import type { ApplicationRunLoopDeps } from './run-loop-contracts.js';
import { appendNativeReasoning, commitPendingNativeReasoning } from './run-native-reasoning.js';
import { EventQueue, outputPush } from './run-segment-events.js';
import type { ModelExchange, ModelToolCall, RunContext, RunState } from './run-state.js';
import { type ToolPlanEntry } from './tool-call-execution.js';
import { type ToolInvocationContext } from './tool-invocation-context.js';
/** Records request-local response and tool facts synchronously before publication or execution. */
export class RunResponseRecorder {
  constructor(private readonly deps: ApplicationRunLoopDeps) {}
  observeTerminalFailure(
    error: unknown,
    request: { requestId: string; provider?: string; model: string; tier: ServiceTier },
  ): void {
    this.#observeDecisionShadow('failure_triage', () => {
      this.deps.decisionShadowObserver?.observeTerminalFailure(buildFailureObservation(error, request));
    });
  }

  #observeDecisionShadow(kind: string, observe: () => void): void {
    if (!this.deps.decisionShadowObserver) return;
    try {
      observe();
    } catch (error) {
      try {
        this.deps.logDiagnostic?.(
          'Decision shadow observer failed synchronously',
          { kind, error: error instanceof Error ? error.message : String(error) },
          { severity: 'debug', eventType: 'decision_shadow.observer_failed' },
        );
      } catch {
        // Observation and its diagnostics must never affect the run.
      }
    }
  }
  /** Accept response facts before any tool from that response can execute. */
  record(context: RunContext, response: ModelExchange): ModelToolCall[] {
    const { state, stream, queue } = context;
    const {
      streamedToolCalls,
      completion,
      sawToolCall,
      activeRequestId,
      activeRequest,
      deferredNativeReasoning,
      criticalWrapUp,
    } = response;
    let { pendingNativeReasoning } = response;
    if (!completion) {
      if (streamedToolCalls.length === 0) {
        const error = new Error('Application model turn ended without completion');
        this.observeTerminalFailure(error, {
          requestId: activeRequestId,
          provider: state.currentProviderId,
          model: state.agent.model,
          tier: activeRequest ? resolveServiceTier(activeRequest) : 'standard',
        });
        throw error;
      }
      if (!criticalWrapUp) {
        for (const reasoning of deferredNativeReasoning) commitPendingNativeReasoning(state, stream, queue, reasoning);
        commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);
      }
      return criticalWrapUp ? [] : streamedToolCalls;
    }
    const finalCompletion = completion as Extract<StreamedModelTurnEvent, { type: 'completion' }>;
    // A terminal response ends recovery, unlike partial tokens or tool
    // activity. Later failures must not inherit an old episode's deadline.
    state.recoveryBudget?.noteModelResponseCompleted();
    // Commit the authoritative terminal state before handling terminal-only
    // tool calls. Approval may pause immediately after this point, and the
    // continuation must still carry the response that produced the calls.
    // Response IDs are provider-chain state, not generic run metadata. Keep
    // them out of continuation handles for providers that do not support
    // chaining, while still exposing the completed provider response on the
    // current stream for diagnostics.
    if (state.supportsConversationChaining && state.currentProviderId !== undefined) {
      state.responseId = finalCompletion.responseId;
      state.responseProviderId = state.currentProviderId;
    } else {
      state.responseId = undefined;
      state.responseProviderId = undefined;
    }
    let normalizedCompletionUsage: ReturnType<typeof normalizeModelUsage>;
    const upstreamProvider = extractAiSdkUpstreamProvider(finalCompletion.providerMetadata);
    if (finalCompletion.usage !== undefined) {
      normalizedCompletionUsage = normalizeModelUsage(finalCompletion.usage);
      if (upstreamProvider) {
        if (normalizedCompletionUsage) {
          normalizedCompletionUsage.upstream_provider = upstreamProvider;
        } else {
          normalizedCompletionUsage = { upstream_provider: upstreamProvider };
        }
      }
      if (normalizedCompletionUsage) {
        if (normalizedCompletionUsage.prompt_tokens !== undefined) {
          state.lastCompletedInputTokens = normalizedCompletionUsage.prompt_tokens;
          state.inputUsageInvalidatedByCompaction = false;
        }
        const accumulated = addTokenUsage(normalizeModelUsage(state.usage), normalizedCompletionUsage);
        state.usage = {
          ...(accumulated.prompt_tokens !== undefined ? { inputTokens: accumulated.prompt_tokens } : {}),
          ...(accumulated.completion_tokens !== undefined ? { outputTokens: accumulated.completion_tokens } : {}),
          // `total_tokens` is the billable normalized total, including cache
          // creation tokens. Keep it alongside the application aliases so the
          // authoritative run accumulator never reconstructs a smaller total.
          ...(accumulated.total_tokens !== undefined ? { totalTokens: accumulated.total_tokens } : {}),
          ...(accumulated.cache_read_tokens !== undefined ? { cachedInputTokens: accumulated.cache_read_tokens } : {}),
          ...(accumulated.cache_creation_tokens !== undefined
            ? { cacheWriteTokens: accumulated.cache_creation_tokens }
            : {}),
        };
      } else {
        // Providers may carry a future/opaque usage shape. Preserve the old
        // pass-through behavior when normalization cannot recognize it.
        state.usage = finalCompletion.usage;
      }
    } else if (upstreamProvider) {
      normalizedCompletionUsage = { upstream_provider: upstreamProvider };
    } else {
      normalizedCompletionUsage = undefined;
    }
    // Attribute cost while the dispatched request's identity is still known.
    // Emit it immediately so the UI can show this request's cost before the
    // run ends; the terminal result re-delivers the cumulative record list
    // and the session accumulator ignores the duplicates by request id.
    // Only the live queue sees the event: `output`/`newItems` feed
    // persistence and replay, and a cost event must never become a restored
    // history item.
    const record = appendCostRecord(state, {
      requestId: activeRequestId,
      provider: state.currentProviderId,
      model: state.agent.model,
      tier: activeRequest ? resolveServiceTier(activeRequest) : 'standard',
      outcome: 'completed',
      usage: normalizedCompletionUsage,
      providerUsd: finalCompletion.costUsd,
    });
    queue.push({ type: 'cost_update', record });
    // Cost and usage arrive in the same completion metadata, so surface both
    // live. The footer is a per-request indicator: emit this request's own
    // usage, never the run accumulator in `state.usage`.
    if (normalizedCompletionUsage) queue.push({ type: 'usage_update', usage: normalizedCompletionUsage });
    evaluateRunBudget(state, stream, queue, this.deps.logDiagnostic);
    stream.lastResponseId = finalCompletion.responseId;
    stream.rawResponses?.push(finalCompletion);
    // Some provider adapters report function calls only in the terminal
    // completion rather than as separate stream events. Their reasoning may
    // likewise be terminal-only, so associate it before replaying calls.
    const toolCalls = [...streamedToolCalls];
    const hasTerminalReasoning = finalCompletion.output.some(
      (item) => item.type === 'reasoning' && appendNativeReasoning(undefined, item) !== undefined,
    );
    if (hasTerminalReasoning) {
      // Terminal output supplies native ordering and authoritative metadata.
      // Streamed fragments have already been displayed, but are not history.
      pendingNativeReasoning = undefined;
    } else {
      for (const reasoning of deferredNativeReasoning) commitPendingNativeReasoning(state, stream, queue, reasoning);
    }
    for (const item of finalCompletion.output) {
      if (item.type === 'reasoning') {
        // Each terminal native item is independently replayable; encrypted
        // reasoning cannot be concatenated or overwritten by its sibling.
        pendingNativeReasoning = commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);
        pendingNativeReasoning = appendNativeReasoning(undefined, item);
        continue;
      }
      if (item.type === 'tool_call') {
        pendingNativeReasoning = commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);
        if (!sawToolCall) toolCalls.push(item);
        continue;
      }
      if (item.type !== 'provider_opaque') continue;
      pendingNativeReasoning = commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);
      const historyItem: ProviderInputItem = {
        ...item.item,
        providerOpaque: {
          provider: item.provider,
          ...(item.sourceProvider ? { sourceProvider: item.sourceProvider } : {}),
        },
      };
      state.history.push(historyItem);
      state.input.push(item);
      if (isOpenAICompaction(item)) {
        // Completion usage describes the request before native replacement.
        // Retain billed usage/costs; invalidate only the next admission hint.
        state.lastCompletedInputTokens = undefined;
        state.inputUsageInvalidatedByCompaction = true;
      }
      outputPush(stream, queue, { type: 'item', item });
    }
    pendingNativeReasoning = commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);

    const assistantText = finalCompletion.output
      .filter((item): item is Extract<StreamedModelTurnOutput, { type: 'message' }> => item.type === 'message')
      .flatMap((item) => item.content)
      // Whitespace-only output (e.g. a background-notification acknowledgment)
      // must not enter the canonical history: the truthy check used to let
      // "\n\n" through, accumulating junk in model context.
      .map((part) => part.text)
      .filter((text) => text.length > 0)
      .join(ASSISTANT_TEXT_PART_SEPARATOR)
      .trim();
    if (assistantText) {
      stream.finalOutput = assistantText;
      const item: ProviderInputItem = {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: assistantText }],
      };
      state.history.push(item);
      outputPush(stream, queue, { type: 'item', item });
      state.input.push({ type: 'message', role: 'assistant', content: [{ type: 'text', text: assistantText }] });
    }

    return toolCalls;
  }
  toolContext(state: RunState, stream: AgentStream, queue: EventQueue, toolContext: ToolInvocationContext) {
    return {
      tools: state.agent.tools,
      approvals: state.approvals,
      toolContext,
      sessionId: state.sessionId,
      turnId: state.turnId,
      hookScope: state.hookScope,
      ...(state.requestSnapshot ? { requestSnapshot: state.requestSnapshot } : {}),
      onCall: (event: Extract<StreamedModelTurnEvent, { type: 'tool_call' }>) => {
        const callItem: ProviderInputItem = {
          type: event.toolType === 'custom' ? 'custom_tool_call' : 'function_call',
          callId: event.id,
          name: event.name,
          ...(event.toolType === 'custom' ? { input: event.arguments } : { arguments: event.arguments }),
          ...(event.providerMetadata ? { providerData: event.providerMetadata } : {}),
        };
        state.history.push(callItem);
        state.input.push({
          type: 'tool_call',
          id: event.id,
          name: event.name,
          arguments: event.arguments,
          ...(event.toolType ? { toolType: event.toolType } : {}),
          ...(event.providerMetadata ? { providerMetadata: event.providerMetadata } : {}),
        });
        outputPush(stream, queue, { type: 'item', item: callItem });
      },
      onExecutionStarted: (callId: string) => state.live?.session?.acceptToolDispatch(callId),
      ...(state.live?.session?.beforeToolDispatch
        ? {
            beforeToolDispatch: async (callId: string) => {
              await state.live?.session?.beforeToolDispatch?.(callId);
              state.live?.options.signal?.throwIfAborted();
            },
          }
        : {}),
      onDispatch: (entry: ToolPlanEntry) => {
        outputPush(stream, queue, {
          type: 'tool_call_dispatched',
          callId: entry.event.id,
          toolName: entry.event.name,
        });
      },
      onToolStall: (input: { name: string; argumentsText: string; effect: AnyToolDefinition['effect'] }) => {
        const stallEvent = state.runBudget?.observeToolCall(input);
        if (stallEvent)
          emitRunBudgetEvent(state, stallEvent, 'Tool stall evidence', stream, queue, this.deps.logDiagnostic);
      },
      onResult: (entry: ToolPlanEntry, result: unknown) => this.#appendToolResult(state, stream, queue, entry, result),
    };
  }

  #appendToolResult(
    state: RunState,
    stream: AgentStream,
    queue: EventQueue,
    entry: ToolPlanEntry,
    result: unknown,
  ): void {
    const runCodeExecution = getRunCodeExecutionResult(result);
    const visibleResult = runCodeExecution ? (Array.isArray(result) ? result : String(result)) : result;
    const modelOutput: string | readonly StreamedModelToolResultPart[] =
      typeof visibleResult === 'string'
        ? visibleResult
        : isToolResultContentParts(visibleResult)
        ? visibleResult
        : JSON.stringify(visibleResult) ?? String(visibleResult ?? '');
    const resultItem: ProviderInputItem = {
      type: entry.event.toolType === 'custom' ? 'custom_tool_call_output' : 'function_call_result',
      callId: entry.event.id,
      name: entry.event.name,
      output: modelOutput,
      ...(runCodeExecution ? { runCodeExecution: runCodeExecutionMetadata(runCodeExecution) } : {}),
    };
    state.history.push(resultItem);
    state.input.push({
      type: 'tool_result',
      id: entry.event.id,
      output: modelOutput,
      ...(runCodeExecution ? { runCodeExecution: runCodeExecutionMetadata(runCodeExecution) } : {}),
      ...(entry.event.toolType ? { toolType: entry.event.toolType } : {}),
    });
    outputPush(stream, queue, { type: 'item', item: resultItem });
    evaluateRunBudget(state, stream, queue, this.deps.logDiagnostic);
  }
}
/**
 * Tool results may carry provider-neutral content parts (for example the
 * image returned by read_file). Preserve only the known multimodal shape;
 * arbitrary structured tool values retain their historical JSON text form.
 */
const isToolResultContentParts = (value: unknown): value is readonly StreamedModelToolResultPart[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      (('type' in part && part.type === 'text') ||
        ('type' in part && part.type === 'image' && 'image' in part) ||
        ('type' in part && part.type === 'file' && 'file' in part)),
  );
