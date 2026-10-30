import { isDeepStrictEqual } from 'node:util';
import {
  ApplicationRunLoop,
  normalizeApplicationInput,
} from '../../../../source/services/agent-runtime/application-run-loop.js';
import { selectAgentStreamItems } from '../../../../source/services/agent-stream.js';
import type { ToolInvocationContext } from '../../../../source/services/agent-runtime/tool-invocation-context.js';
import type {
  ApplicationAgent,
  NestedRunOptions,
  NestedRunStream,
} from '../../../../source/contracts/nested-run-driver.js';
import type { ContinuationHandle } from '../../../../source/contracts/continuation-handle.js';
import type { ProviderInput, ProviderInputItem } from '../../../../source/contracts/provider-input.js';
import type { StreamedModelTurn } from '../../../../source/contracts/streamed-model-turn.js';
import { isCancellationError } from '../../../../source/lib/harness-invariant-error.js';
import { adoptedModelConversion } from '../../model/adopted/index.js';
import { convertSourceItems } from './conversion.js';
import type { Item, ToolCallId } from '../../model/index.js';
import type { NestedRunRequest, ToolContext } from '../../tools/index.js';
import type { AdoptedModelRegistry } from '../../model/adopted/index.js';
import type { AgentId, EngineEvent } from '../index.js';

/** Live source capabilities for one nested invocation; none are checkpoint data. */
export interface AdoptedNestedBinding {
  readonly parentInvocation: ToolInvocationContext;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly agentId: AgentId;
  readonly role: string;
  readonly models: Pick<AdoptedModelRegistry, 'hasUnsettledReads' | 'trackDetachedRead'>;
  prepare(
    request: NestedRunRequest,
    parent: ToolInvocationContext,
  ): {
    agent: ApplicationAgent;
    input: ProviderInput;
    options: NestedRunOptions;
    resolveModel: (model: string) => StreamedModelTurn | Promise<StreamedModelTurn>;
  };
  emit(event: EngineEvent): void;
  waitForContinuation(input: {
    stream: NestedRunStream;
    handle: ContinuationHandle;
    interruptions: readonly unknown[];
    signal: AbortSignal;
  }): Promise<{ kind: 'continue'; options?: NestedRunOptions } | { kind: 'stop' }>;
}

/** Attach the live nested capability when a portable tool context is constructed. */
export function createAdoptedToolContext(
  context: Omit<ToolContext, 'runNested'>,
  binding: AdoptedNestedBinding,
): ToolContext {
  return { ...context, runNested: createRunNested(binding) };
}

/** Run a child with its caller's actual live context and continuation owner. */
export function createRunNested(binding: AdoptedNestedBinding): ToolContext['runNested'] {
  return async (request) => {
    const partial: Item[] = [];
    if (
      !binding?.parentInvocation?.approvals ||
      !binding.signal ||
      !binding.isCurrent ||
      !binding.agentId ||
      !binding.role ||
      !binding.models ||
      typeof binding.models.hasUnsettledReads !== 'function' ||
      typeof binding.models.trackDetachedRead !== 'function' ||
      typeof binding.prepare !== 'function' ||
      typeof binding.emit !== 'function' ||
      typeof binding.waitForContinuation !== 'function'
    ) {
      throw new Error('Missing live nested invocation binding');
    }
    if (binding.signal.aborted || binding.parentInvocation.signal?.aborted || !binding.isCurrent())
      return { items: partial, outcome: { kind: 'cancelled' } };
    if (binding.models.hasUnsettledReads()) throw new Error('A prior adopted model read has not settled');
    if (request.budget.kind !== 'adopted' || new Set(request.toolNames).size !== request.toolNames.length)
      throw new Error('Invalid adopted nested request');
    const prepared = binding.prepare(request, binding.parentInvocation);
    if (
      !prepared?.agent ||
      !prepared.options?.approvals ||
      typeof prepared.resolveModel !== 'function' ||
      prepared.agent.model !== request.model.model ||
      prepared.options.providerId !== request.model.provider ||
      prepared.agent.instructions !== request.instructions ||
      (request.reasoning !== undefined && request.reasoning !== prepared.agent.modelSettings?.reasoning?.effort) ||
      !isDeepStrictEqual(
        prepared.agent.tools.map((tool) => tool.name),
        request.toolNames,
      ) ||
      !isDeepStrictEqual(
        normalizeApplicationInput(prepared.input),
        request.items.map(adoptedModelConversion.itemToInput),
      )
    ) {
      throw new Error('Nested request does not match its live source binding');
    }
    if (binding.signal.aborted || binding.parentInvocation.signal?.aborted || !binding.isCurrent())
      return { items: partial, outcome: { kind: 'cancelled' } };
    const signals = [
      binding.signal,
      ...(binding.parentInvocation.signal ? [binding.parentInvocation.signal] : []),
      ...(prepared.options.signal ? [prepared.options.signal] : []),
    ];
    const signal = AbortSignal.any(signals);
    const loop = new ApplicationRunLoop({
      resolveModel: prepared.resolveModel,
      abortPendingModelReads: true,
      recordBudgetStopCause: true,
      onDetachedModelRead: (operation) => binding.models.trackDetachedRead(operation),
    });
    const abort = () => loop.abort();
    signal.addEventListener('abort', abort, { once: true });
    const publish = (event: EngineEvent) => {
      if (!signal.aborted && binding.isCurrent())
        binding.emit({ type: 'subagent', agentId: binding.agentId, role: binding.role, event });
    };
    let currentStream: NestedRunStream | undefined;
    let collected = false;
    const collect = () => {
      if (!currentStream || collected) return;
      collected = true;
      const selected = selectAgentStreamItems(currentStream) as ProviderInputItem[];
      const history = selected.filter(
        (entry) => entry.type !== 'tool_call_dispatched' && entry.type !== 'context_compaction_failed',
      );
      partial.push(...convertSourceItems(history, request.model.provider));
    };
    try {
      let stream: NestedRunStream = loop.startStream(prepared.agent, prepared.input, { ...prepared.options, signal });
      while (true) {
        currentStream = stream;
        collected = false;
        void stream.completed.catch(() => undefined);
        for await (const event of stream) {
          if (signal.aborted || !binding.isCurrent()) {
            loop.abort();
            collect();
            return { items: partial, outcome: { kind: 'cancelled' } };
          }
          if (event.type === 'text_delta') publish({ type: 'text_delta', delta: event.text });
          else if (event.type === 'reasoning_delta') publish({ type: 'reasoning_delta', delta: event.text });
          else if (event.type === 'model_attempt_rollback')
            publish({ type: 'model_attempt_rollback', reasoningCharacters: event.reasoningCharacters });
          else if (event.type === 'item')
            for (const item of convertSourceItems([event.item], request.model.provider))
              publish({ type: 'item', item });
          else if (event.type === 'tool_call_dispatched')
            publish({
              type: 'tool_started',
              callId: event.callId as ToolCallId,
              toolName: event.toolName,
              input: undefined,
            });
          else if (event.type === 'usage_update')
            publish({
              type: 'usage',
              usage: {
                inputTokens: event.usage.prompt_tokens ?? 0,
                outputTokens: event.usage.completion_tokens ?? 0,
                cachedInputTokens: event.usage.cache_read_tokens ?? 0,
              },
            });
        }
        await stream.completed;
        collect();
        if (signal.aborted || !binding.isCurrent() || stream.cancelled)
          return { items: partial, outcome: { kind: 'cancelled' } };
        if (stream.terminalCause === 'budget_exhausted')
          return { items: partial, outcome: { kind: 'budget_exhausted' } };
        if (stream.terminalCause)
          return { items: partial, outcome: { kind: 'interrupted', terminalCause: stream.terminalCause } };
        if (!stream.interruptions?.length) return { items: partial, outcome: { kind: 'completed' } };
        if (!stream.state) return { items: partial, outcome: { kind: 'interrupted' } };
        const decisionPromise = binding.waitForContinuation({
          stream,
          handle: stream.state,
          interruptions: stream.interruptions,
          signal,
        });
        void decisionPromise.catch(() => undefined);
        const decision = await new Promise<Awaited<typeof decisionPromise>>((resolve, reject) => {
          const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
          decisionPromise
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', onAbort))
            .catch(() => undefined);
        });
        if (decision.kind === 'stop') return { items: partial, outcome: { kind: 'interrupted' } };
        if (signal.aborted || !binding.isCurrent()) return { items: partial, outcome: { kind: 'cancelled' } };
        stream = loop.continueRunStream(stream.state, { ...decision.options, signal });
      }
    } catch (error) {
      try {
        collect();
      } catch {
        /* Preserve the original failure. */
      }
      if (signal.aborted || !binding.isCurrent() || isCancellationError(error))
        return { items: partial, outcome: { kind: 'cancelled' } };
      return {
        items: partial,
        outcome: { kind: 'failed', error: { kind: 'provider', message: 'Nested run failed', retryable: false } },
      };
    } finally {
      signal.removeEventListener('abort', abort);
      loop.abort();
    }
  };
}
