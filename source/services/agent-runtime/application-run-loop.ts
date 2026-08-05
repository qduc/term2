import { z } from 'zod';
import type { ProviderInput, ProviderInputItem } from '../../contracts/provider-input.js';
import type { JsonSchemaDefinition } from '../../contracts/model-types.js';
import type { ApplicationRunEvent } from '../../contracts/application-stream.js';
import {
  createContinuationHandle,
  unwrapContinuationHandle,
  type ContinuationHandle,
} from '../../contracts/continuation-handle.js';
import { createAgentStream, type AgentStream } from '../agent-stream.js';
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
import type {
  AnyToolDefinition,
  ToolExecutionLifecycleContext,
  ToolExecutionLifecyclePort,
  ToolRegistry,
} from '../../tools/types.js';
import { isZodToolParameterSchema } from '../../tools/types.js';
import type { Term2HookScope } from '../hooks/hook-contracts.js';
import { normalizeToolParameters } from '../../lib/tool-invoke.js';
import { isCancellationError, isHarnessInvariantError } from '../../lib/harness-invariant-error.js';
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
  /** Public hook correlation for the logical session turn. */
  readonly turnId?: string;
  /** Root/subagent ownership for observational tool events. */
  readonly hookScope?: Term2HookScope;
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
  readonly toolLifecycle?: ToolExecutionLifecyclePort;
  /**
   * Diagnostics sink. Optional so no construction site or test has to supply
   * one. Used to report the fate of steers, which is otherwise invisible: a
   * turn spans several runs, and a steer only survives the run it was handed to.
   */
  readonly logDiagnostic?: (message: string, meta: Record<string, unknown>) => void;
}

/** A user message waiting for the running turn's next request boundary. */
type PendingSteer = {
  readonly items: readonly ProviderInputItem[];
  readonly resolve: (admitted: boolean) => void;
};

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
  /**
   * Identical failing tool calls seen so far, keyed by tool + arguments +
   * error. Preserved across continuation so an approval round-trip does not
   * reset the retry budget.
   */
  toolFailureCounts?: Map<string, number>;
  /** Keep provider response IDs out of requests for providers that do not support them. */
  supportsConversationChaining: boolean;
  /** Provider currently executing this continuation. */
  currentProviderId?: string;
  /** Provider that originated responseId; absent on legacy handles. */
  responseProviderId?: string;
  /** Root-only provider request preparation, retained by continuations. */
  requestPreparation?: ApplicationRequestPreparation;
  sessionId?: string;
  turnId?: string;
  hookScope?: Term2HookScope;
  toolAttempts?: Map<string, number>;
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
  #runInFlight = false;
  /**
   * Set when a segment ends holding approvals, meaning the turn is pausing
   * rather than finishing. Injections offered during the pause wait here for
   * the continuation segment instead of being refused for want of a run.
   */
  #turnPaused = false;
  #pendingSteers: PendingSteer[] = [];

  constructor(deps: ApplicationRunLoopDeps) {
    this.#deps = deps;
  }

  abort(): void {
    this.abortSegment();
    // An aborted turn will not resume, so nothing may keep waiting on it.
    this.#turnPaused = false;
    this.#releasePendingSteers({ reason: 'aborted' });
  }

  /**
   * Stop the segment currently streaming without judging the turn's fate.
   *
   * Resuming a paused turn goes through here, so waiting injections survive;
   * only `abort`, which means the turn itself is over, discards them.
   */
  abortSegment(): void {
    this.#activeAbortController?.abort();
    this.#activeAbortController = null;
  }

  /**
   * Hand the running turn a user message to send with its next model request.
   *
   * The loop admits it at a request boundary — after the tool results of the
   * current round are in history and before the next request is built — so the
   * model reads it in sequence without the turn being interrupted. Nothing is
   * cancelled, and a tool already running is untouched.
   *
   * The wait spans the whole turn, not just the segment it was offered to: a
   * turn that pauses for an approval resumes as a new segment, and the message
   * is admitted at that segment's first boundary.
   *
   * Resolves `true` once the message has been admitted, and `false` when the
   * turn ends first (or none is running): it offered no further request
   * boundary, so the caller must send the message as its own turn instead.
   */
  steer(items: readonly ProviderInputItem[]): Promise<boolean> {
    if (items.length === 0) return Promise.resolve(false);
    if (!this.#runInFlight && !this.#turnPaused) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.#pendingSteers.push({ items, resolve });
    });
  }

  /** Settle every steer this run did not admit so callers stop waiting on it. */
  #releasePendingSteers(reason: Record<string, unknown> = {}): void {
    const pending = this.#pendingSteers;
    this.#pendingSteers = [];
    if (pending.length > 0) {
      this.#deps.logDiagnostic?.('Steer released at run end', { released: pending.length, ...reason });
    }
    for (const steer of pending) steer.resolve(false);
  }

  /**
   * Append waiting steers to the turn as ordinary user messages.
   *
   * They enter history and model input exactly as a user turn does — never
   * folded into a tool result — so the provider sees the user speaking after
   * the tool results of the round that was in flight when they typed.
   */
  #admitPendingSteers(state: RunState, stream: AgentStream, queue: EventQueue): void {
    if (this.#pendingSteers.length === 0) return;
    const admitted = this.#pendingSteers;
    this.#pendingSteers = [];
    this.#deps.logDiagnostic?.('Steer admitted at request boundary', {
      admitted: admitted.length,
      turnCount: state.turnCount,
    });
    for (const steer of admitted) {
      for (const item of steer.items) {
        state.history.push(item);
        state.input.push(...normalizeApplicationInput([item]));
        outputPush(stream, queue, { type: 'item', item });
      }
      steer.resolve(true);
    }
  }

  startStream(agent: ApplicationAgent, input: ProviderInput, options: ApplicationRunLoopOptions = {}): AgentStream {
    // A new turn starts here. Anything still waiting belonged to the previous
    // turn and can never be admitted now, so settle it rather than letting it
    // leak into work the user did not aim it at.
    this.#turnPaused = false;
    this.#releasePendingSteers({ reason: 'superseded_by_new_turn' });
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
      sessionId: options.sessionId,
      turnId: options.turnId,
      hookScope: options.hookScope,
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
    if (options.sessionId !== undefined) state.sessionId = options.sessionId;
    if (options.turnId !== undefined) state.turnId = options.turnId;
    if (options.hookScope !== undefined) state.hookScope = options.hookScope;
    return this.#run(state, options);
  }

  #run(state: RunState, options: ApplicationRunLoopOptions): AgentStream {
    const queue = new EventQueue();
    this.abortSegment();
    const controller = new AbortController();
    this.#activeAbortController = controller;
    this.#runInFlight = true;
    // This segment is running, so the turn is no longer paused between them.
    this.#turnPaused = false;
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
      get runUsage() {
        return state.usage;
      },
    });

    let exitError: unknown;
    stream.completed = this.#execute(state, stream, queue, effectiveOptions, toolContext)
      .catch((error) => {
        exitError = error;
        stream.cancelled = error instanceof Error && error.name === 'AbortError';
        queue.close(error);
        throw error;
      })
      .finally(() => {
        if (this.#activeAbortController === controller) this.#activeAbortController = null;
        this.#runInFlight = false;
        // A segment that ends holding approvals has paused the turn, not ended
        // it: the caller resumes through continueRunStream, which offers
        // another request boundary. Injections wait for it. Only a segment
        // that ends with nothing outstanding has truly finished the turn, and
        // then anything still waiting has to be sent as its own turn instead.
        const pendingApprovals = state.pendingApprovals?.length ?? 0;
        const cancelled = stream.cancelled === true;
        this.#turnPaused = pendingApprovals > 0 && !cancelled && exitError === undefined;
        if (this.#turnPaused) return;
        this.#releasePendingSteers({
          pendingApprovals,
          cancelled,
          error: exitError instanceof Error ? exitError.name : exitError ? String(exitError) : undefined,
          turnCount: state.turnCount,
        });
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
          ? await this.#invokeTool(pending.definition, pending.params, toolContext, pending.callId, state)
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

      // The request boundary: every tool result of the previous round is in
      // history, and the next request has not been built. A user message
      // admitted here reaches the model in sequence, mid-turn.
      this.#admitPendingSteers(state, stream, queue);

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
          if (event.type === 'tool_call_streaming_delta') {
            outputPush(stream, queue, event);
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
      const result = await this.#invokeTool(definition, params, toolContext, event.id, state);
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

    const result = await this.#invokeTool(definition, params, toolContext, event.id, state);
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

  /**
   * A tool that throws must not take the run down with it.
   *
   * Most tools already report failure by returning `Error: ...` as their
   * output, which the model reads and acts on. The handful that throw got the
   * opposite treatment for no principled reason: the exception escaped to
   * `#execute`, closed the event queue, and ended the turn — so the model never
   * saw a recoverable problem like a path that does not exist, and the caller
   * lost the whole turn. Worse, `#handleToolCall` pushes the `function_call`
   * into history before executing, so an escape leaves a call with no matching
   * result.
   *
   * Errors are therefore normalized into tool output, with two exceptions that
   * must still propagate: cancellation (the run is ending on purpose) and
   * `HarnessInvariantError` (a bug here, which the model cannot act on).
   */
  async #invokeTool(
    definition: AnyToolDefinition,
    params: unknown,
    toolContext: ToolInvocationContext,
    callId: string,
    state?: RunState,
  ): Promise<unknown> {
    const startedAt = Date.now();
    const attempt = state
      ? ((state.toolAttempts ??= new Map()).set(callId, (state.toolAttempts.get(callId) ?? 0) + 1),
        state.toolAttempts.get(callId)!)
      : 1;
    const lifecycleContext: ToolExecutionLifecycleContext = {
      ...(state?.sessionId ? { sessionId: state.sessionId } : {}),
      ...(state?.turnId ? { turnId: state.turnId } : {}),
      toolCallId: callId,
      toolName: definition.name,
      normalizedArguments: params,
      attempt,
      scope: state?.hookScope ?? 'root',
    };
    await this.#notifyToolLifecycle(() => this.#deps.toolLifecycle?.before(lifecycleContext));
    try {
      const result = await definition.execute(params, toolContext, { toolCall: { callId } });
      await this.#notifyToolLifecycle(() =>
        this.#deps.toolLifecycle?.after(lifecycleContext, result, Date.now() - startedAt),
      );
      return result;
    } catch (error) {
      if (isCancellationError(error) || isHarnessInvariantError(error) || error instanceof MaxTurnsExceededError) {
        await this.#notifyToolLifecycle(() =>
          this.#deps.toolLifecycle?.error(lifecycleContext, error, Date.now() - startedAt, false),
        );
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      // Feeding the same failure back forever is its own failure mode: some
      // errors no argument can fix. Repeat the identical result once, then say
      // so plainly rather than inviting a third identical attempt.
      const repeated = state ? countRepeatedFailure(state, definition.name, params, message) : 1;
      if (repeated > MAX_IDENTICAL_TOOL_FAILURES) {
        const result = `Error: ${message}\n\nThis exact call has now failed ${repeated} times with the same error. Do not call ${definition.name} with these arguments again — either change your approach or report the problem to the user.`;
        await this.#notifyToolLifecycle(() =>
          this.#deps.toolLifecycle?.error(lifecycleContext, error, Date.now() - startedAt, true),
        );
        return result;
      }
      const result = `Error: ${message}`;
      await this.#notifyToolLifecycle(() =>
        this.#deps.toolLifecycle?.error(lifecycleContext, error, Date.now() - startedAt, true),
      );
      return result;
    }
  }

  async #notifyToolLifecycle(operation: (() => void | Promise<void>) | undefined): Promise<void> {
    if (!operation) return;
    try {
      await operation();
    } catch {
      // Lifecycle observers are passive. A broken observer must not alter tool
      // execution or turn recovery semantics.
    }
  }
}

/**
 * How many times an identical failing call is fed back before the loop stops
 * inviting retries. One repeat is worth allowing: a transient failure resolves,
 * and a model given the error often corrects on its second attempt.
 */
const MAX_IDENTICAL_TOOL_FAILURES = 2;

function countRepeatedFailure(state: RunState, toolName: string, params: unknown, message: string): number {
  let key: string;
  try {
    key = JSON.stringify([toolName, params, message]);
  } catch {
    // Unserializable params cannot be compared for identity; treat every such
    // failure as distinct rather than collapsing unrelated calls together.
    return 1;
  }
  state.toolFailureCounts ??= new Map<string, number>();
  const count = (state.toolFailureCounts.get(key) ?? 0) + 1;
  state.toolFailureCounts.set(key, count);
  return count;
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
