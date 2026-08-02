import { z } from 'zod';
import type { ProviderInput, ProviderInputItem } from '../../contracts/provider-input.js';
import type { JsonSchemaDefinition } from '../../contracts/model-types.js';
import type { ApplicationRunEvent } from '../../contracts/application-stream.js';
import {
  createContinuationHandle,
  unwrapContinuationHandle,
  type ContinuationHandle,
} from '../../contracts/continuation-handle.js';
import type { AgentStream } from '../agent-stream.js';
import type {
  StreamedModelMessagePart,
  StreamedModelProviderOptions,
  StreamedModelToolResultPart,
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnInput,
  StreamedModelTurnRequest,
  StreamedModelTool,
} from '../../contracts/streamed-model-turn.js';
import type { AnyToolDefinition, ToolRegistry } from '../../tools/types.js';
import { isZodToolParameterSchema } from '../../tools/types.js';
import { normalizeToolParameters } from '../../lib/tool-invoke.js';
import { ApprovalLedger, type ToolInvocationContext } from './tool-invocation-context.js';
import { addTokenUsage, normalizeUsage } from '../../utils/ai/token-usage.js';

/**
 * Fields of `modelSettings` the run loop and provider adapters actually read.
 * Codex-only request fields are modeled separately so they cannot escape into
 * another provider's opaque option bag. The index signature remains for legacy
 * provider settings before they are projected by the application configuration.
 */
export interface AgentModelSettings {
  temperature?: number;
  reasoning?: { effort?: string; summary?: string };
  maxTokens?: number;
  retry?: { maxRetries?: number };
  providerData?: Record<string, unknown>;
  codex?: { promptCacheKey?: string; include?: readonly string[] };
  [key: string]: unknown;
}

/** The application-owned agent shape consumed by the replacement run loop. */
export interface ApplicationAgent {
  readonly name: string;
  readonly instructions: string;
  readonly model: string;
  modelSettings?: AgentModelSettings;
  defaultRunOptions?: any;
  outputType?: JsonSchemaDefinition | 'text';
  readonly tools: ToolRegistry;
}

export interface ApplicationRequestPreparation {
  /** Observe the exact application request immediately before model dispatch. */
  readonly prepare: (request: StreamedModelTurnRequest) => void;
  /** Keep request preparation context alive for the complete async model request. */
  readonly run: <T>(operation: () => Promise<T>) => Promise<T>;
}

export interface ApplicationRunLoopOptions {
  readonly signal?: AbortSignal;
  /** Existing provider response to continue from on the first model turn. */
  readonly previousResponseId?: string | null;
  /** Identity of the provider making this run. Required to establish response provenance. */
  readonly providerId?: string;
  /** Whether this provider accepts response IDs for continuation requests. */
  readonly supportsConversationChaining?: boolean;
  readonly sessionId?: string;
  /** Per-run user context delivered to tools as `ToolInvocationContext.context`. */
  readonly context?: unknown;
  /**
   * The run's approval ledger; a fresh one is created when omitted. Pass a
   * pre-seeded ledger to honor decisions already taken (e.g. parent approvals
   * replayed into a nested run — the F5 mechanism).
   */
  readonly approvals?: ApprovalLedger;
  /**
   * Maximum model turns for this run. One turn is one model call, matching the
   * removed SDK's accounting. Exceeding it throws {@link MaxTurnsExceededError}.
   * Omitted means unbounded — callers that had a limit under the SDK (the chat
   * client, subagents, the mentor) must pass theirs.
   */
  readonly maxTurns?: number;
  /** Root-only provider request preparation, retained by continuations. */
  readonly requestPreparation?: ApplicationRequestPreparation;
}

/**
 * Raised when a run exceeds its `maxTurns` budget. The loop owns turn counting
 * — the SDK-era `callModelInputFilter` hook is deliberately not reintroduced.
 */
export class MaxTurnsExceededError extends Error {
  readonly maxTurns: number;

  constructor(maxTurns: number) {
    super(`Max turns (${maxTurns}) exceeded`);
    this.name = 'MaxTurnsExceededError';
    this.maxTurns = maxTurns;
  }
}

export interface ApplicationRunLoopDeps {
  readonly resolveModel: (model: string) => StreamedModelTurn | Promise<StreamedModelTurn>;
}

type PendingApproval = {
  callId: string;
  toolName: string;
  argumentsText: string;
  interruption: Record<string, unknown>;
  definition: AnyToolDefinition;
  params: unknown;
};

type RunState = {
  agent: ApplicationAgent;
  input: StreamedModelTurnInput[];
  history: ProviderInputItem[];
  pendingApproval?: PendingApproval;
  pendingApprovals?: PendingApproval[];
  approvalDecision?: 'approved' | 'rejected';
  approvalDecisionCallId?: string;
  approvalMessage?: string;
  responseId?: string;
  usage?: unknown;
  /** The run's user context (from options), preserved across continuation. */
  context?: unknown;
  /** This run's approval ledger, preserved across continuation. */
  approvals: ApprovalLedger;
  /** Model turns taken so far, preserved across continuation. */
  turnCount: number;
  /** Turn budget for the run; undefined means unbounded. */
  maxTurns?: number;
  /** Keep provider response IDs out of requests for providers that do not support them. */
  supportsConversationChaining: boolean;
  /** Provider currently executing this continuation. */
  currentProviderId?: string;
  /** Provider that originated responseId; absent on legacy handles. */
  responseProviderId?: string;
  /** Root-only provider request preparation, retained by continuations. */
  requestPreparation?: ApplicationRequestPreparation;
  approve?: (_interruption?: unknown) => void;
  reject?: (_interruption?: unknown, options?: { message?: string }) => void;
};

class EventQueue {
  #items: ApplicationRunEvent[] = [];
  #waiters: Array<{
    resolve: (result: IteratorResult<ApplicationRunEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #failure: unknown;

  push(item: ApplicationRunEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: item });
    else this.#items.push(item);
  }

  close(error?: unknown): void {
    this.#closed = true;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  next(): Promise<IteratorResult<ApplicationRunEvent>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ done: false, value: item });
    if (this.#closed) {
      if (this.#failure) return Promise.reject(this.#failure);
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}

/**
 * Small provider-neutral agent loop. It owns model-turn sequencing and tool
 * execution; providers only implement `StreamedModelTurn`.
 */
export class ApplicationRunLoop {
  readonly #deps: ApplicationRunLoopDeps;
  #activeAbortController: AbortController | null = null;

  constructor(deps: ApplicationRunLoopDeps) {
    this.#deps = deps;
  }

  abort(): void {
    this.#activeAbortController?.abort();
    this.#activeAbortController = null;
  }

  startStream(agent: ApplicationAgent, input: ProviderInput, options: ApplicationRunLoopOptions = {}): AgentStream {
    const state: RunState = {
      agent,
      input: normalizeInput(input),
      history: normalizeHistory(input),
      // A response ID is usable only after its provider origin is recorded.
      // This also makes old callers that omit providerId fail closed.
      responseId:
        options.providerId && options.supportsConversationChaining === true
          ? options.previousResponseId ?? undefined
          : undefined,
      pendingApprovals: [],
      supportsConversationChaining: options.supportsConversationChaining === true,
      currentProviderId: options.providerId,
      responseProviderId:
        options.providerId && options.supportsConversationChaining === true && options.previousResponseId
          ? options.providerId
          : undefined,
      requestPreparation: options.requestPreparation,
      context: options.context,
      approvals: options.approvals ?? new ApprovalLedger(),
      turnCount: 0,
      maxTurns: options.maxTurns,
    };
    state.approve = (interruption) => {
      state.approvalDecision = 'approved';
      state.approvalDecisionCallId = getInterruptionCallId(interruption);
    };
    state.reject = (interruption, approvalOptions) => {
      state.approvalDecision = 'rejected';
      state.approvalDecisionCallId = getInterruptionCallId(interruption);
      state.approvalMessage = approvalOptions?.message;
    };
    return this.#run(state, options);
  }

  continueRunStream(handle: ContinuationHandle, options: ApplicationRunLoopOptions = {}): AgentStream {
    const state = unwrapContinuationHandle(handle) as RunState;
    if (!state || typeof state !== 'object' || !('agent' in state) || !('input' in state)) {
      throw new Error('Invalid application continuation state');
    }
    // Handles created before the ledger existed cannot resume meaningfully;
    // give them a fresh ledger rather than crashing on `approvals` access.
    if (!state.approvals) state.approvals = new ApprovalLedger();
    // A continuation handle from before approval batching carried only the
    // current pending item. Normalize it into the queue used by current runs.
    if (!state.pendingApprovals) state.pendingApprovals = state.pendingApproval ? [state.pendingApproval] : [];
    if (!state.pendingApproval && state.pendingApprovals.length > 0) {
      state.pendingApproval = state.pendingApprovals[0];
    }
    // Response IDs are provider-owned. A handle from before provenance was
    // recorded, a missing providerId, or a provider switch must never forward
    // its opaque ID. In particular, do not use previousResponseId as a
    // compatibility fallback here: its origin cannot be proven.
    const previousProviderId = state.currentProviderId;
    const sameProvider =
      typeof previousProviderId === 'string' &&
      typeof options.providerId === 'string' &&
      previousProviderId === options.providerId;
    if (!sameProvider || options.supportsConversationChaining !== true) {
      state.responseId = undefined;
      state.responseProviderId = undefined;
    } else if (options.previousResponseId) {
      // A same-provider caller may supply a refreshed continuity anchor (for
      // example after persisted-session recovery). Its origin is now proven
      // by the provider identity carried in this continuation state.
      state.responseId = options.previousResponseId;
      state.responseProviderId = options.providerId;
    }
    state.currentProviderId = options.providerId;
    // The turn budget belongs to the run, so a resumed run keeps spending the
    // same one rather than starting over after every approval pause.
    if (typeof state.turnCount !== 'number') state.turnCount = 0;
    if (state.maxTurns === undefined) state.maxTurns = options.maxTurns;
    if (typeof state.supportsConversationChaining !== 'boolean') {
      state.supportsConversationChaining = options.supportsConversationChaining === true;
    } else {
      // AgentClient supplies the current provider capability on every resume.
      state.supportsConversationChaining = options.supportsConversationChaining === true;
    }
    // A continuation receives a fresh immutable snapshot from the session;
    // refresh the preparation closure when supplied, while preserving the
    // root closure for callers that do not provide one again.
    if (options.requestPreparation) state.requestPreparation = options.requestPreparation;
    return this.#run(state, options);
  }

  #run(state: RunState, options: ApplicationRunLoopOptions): AgentStream {
    const queue = new EventQueue();
    this.abort();
    const controller = new AbortController();
    this.#activeAbortController = controller;
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
    };
    const output: ApplicationRunEvent[] = [];
    const stream: AgentStream & { finalOutput?: string } = {
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
      get runUsage() {
        return state.usage;
      },
    };

    stream.completed = this.#execute(state, stream, queue, effectiveOptions, toolContext)
      .catch((error) => {
        stream.cancelled = error instanceof Error && error.name === 'AbortError';
        queue.close(error);
        throw error;
      })
      .finally(() => {
        if (this.#activeAbortController === controller) this.#activeAbortController = null;
      });
    return stream;
  }

  async #execute(
    state: RunState,
    stream: AgentStream & { finalOutput?: string },
    queue: EventQueue,
    options: ApplicationRunLoopOptions,
    toolContext: ToolInvocationContext,
  ): Promise<unknown> {
    while (true) {
      if (options.signal?.aborted) throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });

      state.pendingApprovals ??= state.pendingApproval ? [state.pendingApproval] : [];
      if (state.pendingApprovals.length > 0 && state.approvalDecision) {
        const selectedIndex = state.approvalDecisionCallId
          ? state.pendingApprovals.findIndex(
              (pending) => getInterruptionCallId(pending.interruption) === state.approvalDecisionCallId,
            )
          : -1;
        if (state.approvalDecisionCallId && selectedIndex < 0) {
          throw new Error(`Approval decision references unknown pending tool call: ${state.approvalDecisionCallId}`);
        }
        const pendingIndex = selectedIndex >= 0 ? selectedIndex : 0;
        const pending = state.pendingApprovals[pendingIndex];
        const approved = state.approvalDecision === 'approved';
        if (approved) {
          state.approvals.approveTool({ toolName: pending.toolName, callId: pending.callId });
        } else {
          state.approvals.rejectTool(
            { toolName: pending.toolName, callId: pending.callId },
            { message: state.approvalMessage },
          );
        }
        const rawResult = approved
          ? await this.#invokeTool(pending.definition, pending.params, toolContext, pending.callId)
          : state.approvalMessage ?? 'rejected';
        const result = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
        const resultItem: ProviderInputItem = {
          type: 'function_call_result',
          callId: pending.callId,
          name: pending.toolName,
          output: result,
        };
        state.history.push(resultItem);
        state.input.push({ type: 'tool_result', id: pending.callId, output: result });
        outputPush(stream, queue, { type: 'item', item: resultItem });
        state.pendingApprovals.splice(pendingIndex, 1);
        state.pendingApproval = state.pendingApprovals[0];
        state.approvalDecision = undefined;
        state.approvalDecisionCallId = undefined;
        state.approvalMessage = undefined;
        stream.interruptions = state.pendingApprovals.map((item) => item.interruption);
        if (state.pendingApprovals.length > 0) return finish(stream, state, queue);
      }

      state.turnCount += 1;
      if (state.maxTurns !== undefined && state.turnCount > state.maxTurns) {
        throw new MaxTurnsExceededError(state.maxTurns);
      }

      const model = await this.#deps.resolveModel(state.agent.model);
      let sawToolCall = false;
      let completion: Extract<StreamedModelTurnEvent, { type: 'completion' }> | undefined;
      let pendingNativeReasoning: PendingNativeReasoning | undefined;

      const request: StreamedModelTurnRequest = {
        instructions: state.agent.instructions,
        ...(state.supportsConversationChaining &&
        state.responseId &&
        state.responseProviderId !== undefined &&
        state.responseProviderId === state.currentProviderId
          ? { previousResponseId: state.responseId }
          : {}),
        input: state.input,
        tools: toModelTools(state.agent.tools),
        applicationTools: state.agent.tools,
        ...(state.agent.modelSettings?.temperature !== undefined
          ? { temperature: state.agent.modelSettings.temperature as number }
          : {}),
        ...(state.agent.modelSettings?.reasoning ? { reasoning: state.agent.modelSettings.reasoning as any } : {}),
        ...(state.agent.modelSettings?.maxTokens !== undefined
          ? { maxTokens: state.agent.modelSettings.maxTokens }
          : {}),
        ...(state.agent.outputType !== undefined ? { outputType: state.agent.outputType } : {}),
        ...(state.agent.modelSettings?.codex ? { codex: state.agent.modelSettings.codex } : {}),
        ...(state.agent.modelSettings?.providerData ? { providerOptions: state.agent.modelSettings.providerData } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      const consume = async (): Promise<void> => {
        for await (const event of model.stream(request)) {
          if (event.type === 'completion') {
            completion = event;
            continue;
          }
          if (event.type === 'text_delta') {
            outputPush(stream, queue, { type: 'text_delta', text: event.text });
            continue;
          }
          if (event.type === 'codex_rate_limits') {
            outputPush(stream, queue, { type: 'codex_rate_limits', rateLimits: event.rateLimits });
            continue;
          }
          if (event.type === 'reasoning_delta') {
            pendingNativeReasoning = appendNativeReasoning(pendingNativeReasoning, event);
            outputPush(stream, queue, { type: 'reasoning_delta', text: event.text });
            continue;
          }
          if (event.type === 'tool_call') {
            pendingNativeReasoning = commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);
            sawToolCall = true;
            await this.#handleToolCall(state, stream, queue, event, toolContext);
          }
        }
      };
      const dispatch = async (): Promise<void> => {
        state.requestPreparation?.prepare(request);
        await consume();
      };
      if (state.requestPreparation) await state.requestPreparation.run(dispatch);
      else await dispatch();

      if (!completion) throw new Error('Application model turn ended without completion');
      // Commit the authoritative terminal state before handling terminal-only
      // tool calls. Approval may pause immediately after this point, and the
      // continuation must still carry the response that produced the calls.
      // Response IDs are provider-chain state, not generic run metadata. Keep
      // them out of continuation handles for providers that do not support
      // chaining, while still exposing the completed provider response on the
      // current stream for diagnostics.
      if (state.supportsConversationChaining && state.currentProviderId !== undefined) {
        state.responseId = completion.responseId;
        state.responseProviderId = state.currentProviderId;
      } else {
        state.responseId = undefined;
        state.responseProviderId = undefined;
      }
      if (completion.usage !== undefined) {
        const normalizedCompletionUsage = normalizeModelUsage(completion.usage);
        if (normalizedCompletionUsage) {
          const accumulated = addTokenUsage(normalizeModelUsage(state.usage), normalizedCompletionUsage);
          state.usage = {
            ...(accumulated.prompt_tokens !== undefined ? { inputTokens: accumulated.prompt_tokens } : {}),
            ...(accumulated.completion_tokens !== undefined ? { outputTokens: accumulated.completion_tokens } : {}),
            // `total_tokens` is the billable normalized total, including cache
            // creation tokens. Keep it alongside the application aliases so the
            // authoritative run accumulator never reconstructs a smaller total.
            ...(accumulated.total_tokens !== undefined ? { totalTokens: accumulated.total_tokens } : {}),
            ...(accumulated.cache_read_tokens !== undefined
              ? { cachedInputTokens: accumulated.cache_read_tokens }
              : {}),
            ...(accumulated.cache_creation_tokens !== undefined
              ? { cacheWriteTokens: accumulated.cache_creation_tokens }
              : {}),
          };
        } else {
          // Providers may carry a future/opaque usage shape. Preserve the old
          // pass-through behavior when normalization cannot recognize it.
          state.usage = completion.usage;
        }
      }
      stream.lastResponseId = completion.responseId;
      stream.rawResponses?.push(completion);
      // Some provider adapters report function calls only in the terminal
      // completion rather than as separate stream events. Their reasoning may
      // likewise be terminal-only, so associate it before replaying calls.
      if (!sawToolCall) {
        for (const item of completion.output) {
          if (item.type === 'reasoning') pendingNativeReasoning = appendNativeReasoning(pendingNativeReasoning, item);
        }
        for (const item of completion.output) {
          if (item.type !== 'tool_call') continue;
          pendingNativeReasoning = commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);
          sawToolCall = true;
          await this.#handleToolCall(state, stream, queue, item, toolContext);
        }
      }
      // A native reasoning item belongs to the completed assistant turn even
      // when no tool call follows it. Commit it before assistant text so both
      // stateless continuation and persisted canonical history retain the
      // provider-specific metadata exactly once.
      pendingNativeReasoning = commitPendingNativeReasoning(state, stream, queue, pendingNativeReasoning);

      const assistantText = completion.output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content)
        .map((part) => part.text)
        .join('');
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

      if (state.pendingApprovals.length > 0) {
        stream.interruptions = state.pendingApprovals.map((item) => item.interruption);
        return finish(stream, state, queue);
      }
      if (!sawToolCall) return finish(stream, state, queue);
    }
  }

  async #handleToolCall(
    state: RunState,
    stream: AgentStream,
    queue: EventQueue,
    event: Extract<StreamedModelTurnEvent, { type: 'tool_call' }>,
    toolContext: ToolInvocationContext,
  ): Promise<void> {
    const definition = state.agent.tools.find((tool) => tool.name === event.name);
    const args = parseArguments(event.arguments);
    const callItem: ProviderInputItem = {
      type: 'function_call',
      callId: event.id,
      name: event.name,
      arguments: event.arguments,
    };
    state.history.push(callItem);
    state.input.push({ type: 'tool_call', id: event.id, name: event.name, arguments: event.arguments });
    outputPush(stream, queue, { type: 'item', item: callItem });
    if (!definition) {
      const output = `Unknown tool: ${event.name}`;
      const resultItem: ProviderInputItem = {
        type: 'function_call_result',
        callId: event.id,
        name: event.name,
        output,
      };
      state.history.push(resultItem);
      state.input.push({ type: 'tool_result', id: event.id, output });
      outputPush(stream, queue, { type: 'item', item: resultItem });
      return;
    }

    // Keep the raw-model invocation contract: normalization repairs the
    // accepted object shape but intentionally does not Zod-parse it, which
    // would apply schema defaults before execute. web_fetch relies on its
    // executor fallbacks on the strict JSON-schema path.
    const params = normalizeToolParameters(args, definition.parameters);

    // Consult this run's ledger before prompting: a decision already taken
    // (in the parent run and replayed in, or earlier in this run) must not
    // prompt again. This is what makes approval replay observable.
    const alreadyDecided = state.approvals.isToolApproved({ toolName: event.name, callId: event.id });
    if (alreadyDecided === false) {
      const message = state.approvals.getRejectionMessage(event.name, event.id) ?? 'Tool execution was not approved.';
      const resultItem: ProviderInputItem = {
        type: 'function_call_result',
        callId: event.id,
        name: event.name,
        output: message,
      };
      state.history.push(resultItem);
      state.input.push({ type: 'tool_result', id: event.id, output: message });
      outputPush(stream, queue, { type: 'item', item: resultItem });
      return;
    }

    if (alreadyDecided === true) {
      const result = await this.#invokeTool(definition, params, toolContext, event.id);
      const output = typeof result === 'string' ? result : JSON.stringify(result);
      const resultItem: ProviderInputItem = {
        type: 'function_call_result',
        callId: event.id,
        name: event.name,
        output,
      };
      state.history.push(resultItem);
      state.input.push({ type: 'tool_result', id: event.id, output });
      outputPush(stream, queue, { type: 'item', item: resultItem });
      return;
    }

    if (await definition.needsApproval(params, toolContext)) {
      const pending: PendingApproval = {
        callId: event.id,
        toolName: event.name,
        argumentsText: event.arguments,
        interruption: {
          type: 'tool_approval_item',
          rawItem: { type: 'function_call', callId: event.id, name: event.name, arguments: event.arguments },
          callId: event.id,
          name: event.name,
          arguments: event.arguments,
        },
        definition,
        params,
      };
      state.pendingApprovals ??= [];
      if (!state.pendingApproval) state.pendingApproval = pending;
      state.pendingApprovals.push(pending);
      stream.interruptions = state.pendingApprovals.map((item) => item.interruption);
      return;
    }

    const result = await this.#invokeTool(definition, params, toolContext, event.id);
    const output = typeof result === 'string' ? result : JSON.stringify(result);
    const resultItem: ProviderInputItem = {
      type: 'function_call_result',
      callId: event.id,
      name: event.name,
      output,
    };
    state.history.push(resultItem);
    state.input.push({ type: 'tool_result', id: event.id, output });
    outputPush(stream, queue, { type: 'item', item: resultItem });
  }

  async #invokeTool(
    definition: AnyToolDefinition,
    params: unknown,
    toolContext: ToolInvocationContext,
    callId: string,
  ): Promise<unknown> {
    return definition.execute(params, toolContext, { toolCall: { callId } });
  }
}

function outputPush(stream: AgentStream, queue: EventQueue, item: ApplicationRunEvent): void {
  stream.output.push(item);
  if (stream.newItems !== stream.output) stream.newItems.push(item);
  queue.push(item);
}

function finish(stream: AgentStream, state: RunState, queue: EventQueue): unknown {
  stream.history = state.history;
  if (
    state.supportsConversationChaining &&
    state.responseId &&
    state.responseProviderId !== undefined &&
    state.responseProviderId === state.currentProviderId
  ) {
    stream.lastResponseId = state.responseId;
  } else {
    stream.lastResponseId = null;
  }
  queue.close();
  return { usage: state.usage, output: stream.output };
}

type PendingNativeReasoning = {
  id?: string;
  text: string;
  providerMetadata: StreamedModelProviderOptions;
};

/**
 * Only replay native reasoning when the provider explicitly supplies the
 * Chat-Completions continuation field. Generic reasoning remains display-only
 * so providers with different native formats are not given a foreign field.
 */
function appendNativeReasoning(
  current: PendingNativeReasoning | undefined,
  event: {
    readonly id?: string;
    readonly text: string;
    readonly providerMetadata?: StreamedModelProviderOptions;
  },
): PendingNativeReasoning | undefined {
  const nativeReasoning = event.providerMetadata?.reasoning_content;
  if (typeof nativeReasoning === 'string') {
    const text =
      current?.text === nativeReasoning
        ? current.text
        : current?.text && nativeReasoning.startsWith(current.text)
        ? nativeReasoning
        : `${current?.text ?? ''}${nativeReasoning}`;
    return {
      ...(event.id ? { id: event.id } : current?.id ? { id: current.id } : {}),
      text,
      providerMetadata: { ...event.providerMetadata, reasoning_content: text },
    };
  }
  // Responses providers return encrypted reasoning only on their terminal
  // output. Their metadata is namespaced, so retain it without turning it into
  // the Chat-Completions-only reasoning_content convention.
  if (asRecord(event.providerMetadata?.codex) || asRecord(event.providerMetadata?.openai)) {
    return {
      ...(event.id ? { id: event.id } : current?.id ? { id: current.id } : {}),
      text: event.text,
      providerMetadata: event.providerMetadata!,
    };
  }
  return current;
}

function commitPendingNativeReasoning(
  state: RunState,
  stream: AgentStream,
  queue: EventQueue,
  pending: PendingNativeReasoning | undefined,
): undefined {
  if (!pending) return undefined;
  const reasoningInput: StreamedModelTurnInput = {
    type: 'reasoning',
    ...(pending.id ? { id: pending.id } : {}),
    text: pending.text,
    providerMetadata: pending.providerMetadata,
  };
  const reasoningHistory: ProviderInputItem = {
    type: 'reasoning',
    ...(pending.id ? { id: pending.id } : {}),
    content: [{ type: 'reasoning_text', text: pending.text }],
    providerData: pending.providerMetadata,
  };
  state.input.push(reasoningInput);
  state.history.push(reasoningHistory);
  outputPush(stream, queue, { type: 'item', item: reasoningHistory });
  return undefined;
}

function normalizeModelUsage(usage: unknown) {
  if (!usage || typeof usage !== 'object') return undefined;
  const rawUsage = usage as Record<string, unknown>;
  return normalizeUsage({
    ...rawUsage,
    cacheReadTokens: rawUsage.cachedInputTokens ?? rawUsage.cacheReadTokens,
    cacheCreationTokens: rawUsage.cacheWriteTokens ?? rawUsage.cacheCreationTokens,
  });
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function getInterruptionCallId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const callId = (value as { callId?: unknown }).callId;
  return typeof callId === 'string' ? callId : undefined;
}

function toModelTools(tools: ToolRegistry): StreamedModelTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: isJsonSchema(tool.parameters) ? tool.parameters : z.toJSONSchema(tool.parameters),
  }));
}

function isJsonSchema(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isZodToolParameterSchema(value);
}

/**
 * The canonical application projection used for both model requests and
 * continuation-prefix comparisons. Keep this at the application boundary so
 * callers never need to inspect opaque continuation state.
 */
export function normalizeApplicationInput(
  input: ProviderInput | readonly ProviderInputItem[],
): StreamedModelTurnInput[] {
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: [{ type: 'text', text: input }] }];
  const items = (Array.isArray(input) ? input : [input]) as readonly ProviderInputItem[];
  return items.flatMap((item) => normalizeInputItem(item));
}

function normalizeInput(input: ProviderInput): StreamedModelTurnInput[] {
  return normalizeApplicationInput(input);
}

function normalizeHistory(input: ProviderInput): ProviderInputItem[] {
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: input }];
  return Array.isArray(input) ? [...input] : [input];
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

function unsupportedInput(description: string): never {
  throw new Error(`Unsupported restored input ${description}`);
}

function normalizeTextPart(value: unknown, description: string): { type: 'text'; text: string } {
  if (typeof value === 'string') return { type: 'text', text: value };
  const record = asRecord(value);
  if (
    !record ||
    !['text', 'input_text', 'output_text'].includes(String(record.type)) ||
    typeof record.text !== 'string'
  ) {
    unsupportedInput(description);
  }
  return { type: 'text', text: record.text };
}

function normalizeMessageImage(record: UnknownRecord): StreamedModelMessagePart {
  const image = record.image ?? record.image_url;
  const detail = typeof record.detail === 'string' ? record.detail : undefined;
  if (image === undefined) return { type: 'image', ...(detail ? { detail } : {}) };
  if (typeof image === 'string') return { type: 'image', image, ...(detail ? { detail } : {}) };
  const reference = asRecord(image);
  if (typeof reference?.id === 'string')
    return { type: 'image', image: { id: reference.id }, ...(detail ? { detail } : {}) };
  unsupportedInput('message image reference');
}

function normalizeMessagePart(value: unknown): StreamedModelMessagePart {
  const record = asRecord(value);
  if (record?.type === 'image' || record?.type === 'input_image') return normalizeMessageImage(record);
  return normalizeTextPart(value, record?.type ? `message content: ${record.type}` : 'message content');
}

function normalizeMessageContent(value: unknown): StreamedModelMessagePart[] {
  if (value === undefined || value === null) return [{ type: 'text', text: '' }];
  return (Array.isArray(value) ? value : [value]).map((part) => normalizeMessagePart(part)!);
}

function isTextMessagePart(
  part: StreamedModelMessagePart,
): part is Extract<StreamedModelMessagePart, { type: 'text' }> {
  return part.type === 'text';
}

function normalizeToolImagePart(record: UnknownRecord): Extract<StreamedModelToolResultPart, { type: 'image' }> {
  const rawImage = record.image ?? record.image_url;
  const detail = typeof record.detail === 'string' ? record.detail : undefined;
  if (rawImage === undefined) return { type: 'image', ...(detail ? { detail } : {}) };
  if (typeof rawImage === 'string') return { type: 'image', image: rawImage, ...(detail ? { detail } : {}) };
  const image = asRecord(rawImage);
  if (!image) unsupportedInput('tool image reference');
  const normalized =
    typeof image.id === 'string'
      ? { id: image.id }
      : typeof image.url === 'string'
      ? { url: image.url }
      : typeof image.fileId === 'string'
      ? { fileId: image.fileId }
      : (typeof image.data === 'string' || image.data instanceof Uint8Array) && typeof image.mediaType === 'string'
      ? { data: image.data, mediaType: image.mediaType }
      : undefined;
  if (!normalized) unsupportedInput('tool image reference');
  return { type: 'image', image: normalized, ...(detail ? { detail } : {}) };
}

function normalizeToolFilePart(record: UnknownRecord): Extract<StreamedModelToolResultPart, { type: 'file' }> {
  const rawFile = record.file ?? record.file_id ?? record.file_url;
  const outerFilename = typeof record.filename === 'string' ? record.filename : undefined;
  if (typeof rawFile === 'string') return { type: 'file', file: rawFile };
  const file = asRecord(rawFile);
  if (!file) unsupportedInput('tool file reference');
  if (typeof file.id === 'string')
    return { type: 'file', file: { id: file.id, ...(outerFilename ? { filename: outerFilename } : {}) } };
  if (typeof file.url === 'string')
    return { type: 'file', file: { url: file.url, ...(outerFilename ? { filename: outerFilename } : {}) } };
  const filename = outerFilename ?? (typeof file.filename === 'string' ? file.filename : undefined);
  if (
    (typeof file.data === 'string' || file.data instanceof Uint8Array) &&
    typeof file.mediaType === 'string' &&
    filename !== undefined
  ) {
    return { type: 'file', file: { data: file.data, mediaType: file.mediaType, filename } };
  }
  unsupportedInput('tool file reference');
}

function normalizeToolResultPart(value: unknown): StreamedModelToolResultPart {
  const record = asRecord(value);
  if (record?.type === 'image' || record?.type === 'input_image') return normalizeToolImagePart(record);
  if (record?.type === 'file' || record?.type === 'input_file') return normalizeToolFilePart(record);
  return normalizeTextPart(value, record?.type ? `tool result part: ${record.type}` : 'tool result part');
}

function normalizeToolResultOutput(value: unknown): string | StreamedModelToolResultPart[] {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (!Array.isArray(value)) unsupportedInput('tool result output');
  return value.map(normalizeToolResultPart);
}

function normalizeReasoningText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .map((part) => {
      const record = asRecord(part);
      if (
        !record ||
        !['reasoning_text', 'text', 'summary_text'].includes(String(record.type)) ||
        typeof record.text !== 'string'
      ) {
        return unsupportedInput('reasoning content part');
      }
      return record.text;
    })
    .join('');
}

function normalizeInputItem(item: ProviderInputItem): StreamedModelTurnInput[] {
  if (item.type === 'function_call') {
    return [
      {
        type: 'tool_call',
        id: String(item.callId ?? item.call_id ?? ''),
        name: String(item.name ?? ''),
        arguments: String(item.arguments ?? '{}'),
      },
    ];
  }
  if (item.type === 'function_call_result' || item.type === 'function_call_output') {
    return [
      {
        type: 'tool_result',
        id: String(item.callId ?? item.call_id ?? item.tool_call_id ?? ''),
        output: normalizeToolResultOutput(item.output),
      },
    ];
  }
  if (item.type === 'reasoning') {
    const providerMetadata: StreamedModelProviderOptions | undefined = item.providerData;
    return [
      {
        type: 'reasoning',
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        text: normalizeReasoningText(item.content ?? item.output ?? ''),
        ...(providerMetadata ? { providerMetadata } : {}),
      },
    ];
  }
  if (item.type !== undefined && item.type !== 'message') unsupportedInput(`item type: ${String(item.type)}`);
  const role =
    item.role === undefined
      ? 'user'
      : item.role === 'assistant' || item.role === 'system' || item.role === 'user'
      ? item.role
      : unsupportedInput(`message role: ${String(item.role)}`);
  const content = normalizeMessageContent(item.content);
  if (role === 'system') {
    const textContent = content.filter(isTextMessagePart);
    if (textContent.length !== content.length) unsupportedInput('system message content');
    return [{ type: 'message', role, content: textContent }];
  }
  return [{ type: 'message', role, content }];
}
