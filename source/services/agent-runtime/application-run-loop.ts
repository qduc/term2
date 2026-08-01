import { z } from 'zod';
import type { ProviderInput, ProviderInputItem } from '../../contracts/provider-input.js';
import {
  createContinuationHandle,
  unwrapContinuationHandle,
  type ContinuationHandle,
} from '../../contracts/continuation-handle.js';
import type { AgentStream } from '../agent-stream.js';
import type {
  StreamedModelTurn,
  StreamedModelTurnEvent,
  StreamedModelTurnInput,
  StreamedModelTool,
} from '../../contracts/streamed-model-turn.js';
import type { AnyToolDefinition, ToolRegistry } from '../../tools/types.js';
import { isZodToolParameterSchema } from '../../tools/types.js';
import { normalizeToolParameters } from '../../lib/tool-invoke.js';
import { ApprovalLedger, type ToolInvocationContext } from './tool-invocation-context.js';

/**
 * Fields of `modelSettings` the run loop and provider adapters actually read
 * (temperature/reasoning at the loop; maxTokens/retry/providerData at the
 * provider boundary). Extra keys (e.g. codex `include`) pass through the index
 * signature without being modeled.
 */
export interface AgentModelSettings {
  temperature?: number;
  reasoning?: { effort?: string; summary?: string };
  maxTokens?: number;
  retry?: { maxRetries?: number };
  providerData?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The application-owned agent shape consumed by the replacement run loop. */
export interface ApplicationAgent {
  readonly name: string;
  readonly instructions: string;
  readonly model: string;
  modelSettings?: AgentModelSettings;
  defaultRunOptions?: any;
  outputType?: any;
  readonly tools: ToolRegistry;
}

export interface ApplicationRunLoopOptions {
  readonly signal?: AbortSignal;
  /** Existing provider response to continue from on the first model turn. */
  readonly previousResponseId?: string | null;
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
  approvalDecision?: 'approved' | 'rejected';
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
  approve?: () => void;
  reject?: (_interruption: unknown, options?: { message?: string }) => void;
};

class EventQueue {
  #items: unknown[] = [];
  #waiters: Array<{
    resolve: (result: IteratorResult<unknown>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #failure: unknown;

  push(item: unknown): void {
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

  next(): Promise<IteratorResult<unknown>> {
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
      responseId: options.previousResponseId ?? undefined,
      context: options.context,
      approvals: options.approvals ?? new ApprovalLedger(),
      turnCount: 0,
      maxTurns: options.maxTurns,
    };
    state.approve = () => {
      state.approvalDecision = 'approved';
    };
    state.reject = (_interruption, approvalOptions) => {
      state.approvalDecision = 'rejected';
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
    // A continuation handle normally already carries the response that owns
    // the pending turn. Older handles may not; use the caller-provided
    // continuity anchor as a compatibility fallback in that case.
    if (state.responseId === undefined && options.previousResponseId) {
      state.responseId = options.previousResponseId;
    }
    // The turn budget belongs to the run, so a resumed run keeps spending the
    // same one rather than starting over after every approval pause.
    if (typeof state.turnCount !== 'number') state.turnCount = 0;
    if (state.maxTurns === undefined) state.maxTurns = options.maxTurns;
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
    const output: unknown[] = [];
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

      if (state.pendingApproval && state.approvalDecision) {
        const pending = state.pendingApproval;
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
        outputPush(stream, queue, { type: 'run_item_stream_event', item: resultItem });
        state.pendingApproval = undefined;
        state.approvalDecision = undefined;
        stream.interruptions = [];
      }

      state.turnCount += 1;
      if (state.maxTurns !== undefined && state.turnCount > state.maxTurns) {
        throw new MaxTurnsExceededError(state.maxTurns);
      }

      const model = await this.#deps.resolveModel(state.agent.model);
      let sawToolCall = false;
      let completion: Extract<StreamedModelTurnEvent, { type: 'completion' }> | undefined;

      for await (const event of model.stream({
        instructions: state.agent.instructions,
        ...(state.responseId ? { previousResponseId: state.responseId } : {}),
        input: state.input,
        tools: toModelTools(state.agent.tools),
        ...(state.agent.modelSettings?.temperature !== undefined
          ? { temperature: state.agent.modelSettings.temperature as number }
          : {}),
        ...(state.agent.modelSettings?.reasoning ? { reasoning: state.agent.modelSettings.reasoning as any } : {}),
        ...(state.agent.modelSettings?.providerData ? { providerOptions: state.agent.modelSettings.providerData } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })) {
        if (event.type === 'completion') {
          completion = event;
          continue;
        }
        if (event.type === 'text_delta') {
          outputPush(stream, queue, { type: 'text_delta', text: event.text });
          continue;
        }
        if (event.type === 'reasoning_delta') {
          outputPush(stream, queue, { type: 'model', event: { type: 'reasoning-delta', delta: event.text } });
          continue;
        }
        if (event.type === 'tool_call') {
          sawToolCall = true;
          await this.#handleToolCall(state, stream, queue, event, toolContext);
          if (state.pendingApproval) return finish(stream, state, queue);
        }
      }

      if (!completion) throw new Error('Application model turn ended without completion');
      // Some provider adapters report function calls only in the terminal
      // completion rather than as separate stream events.
      if (!sawToolCall) {
        for (const item of completion.output) {
          if (item.type !== 'tool_call') continue;
          sawToolCall = true;
          await this.#handleToolCall(state, stream, queue, item, toolContext);
          if (state.pendingApproval) return finish(stream, state, queue);
        }
      }
      state.responseId = completion.responseId;
      state.usage = completion.usage;
      stream.lastResponseId = completion.responseId;
      stream.rawResponses?.push(completion);
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
        outputPush(stream, queue, { type: 'run_item_stream_event', item });
        state.input.push({ type: 'message', role: 'assistant', content: [{ type: 'text', text: assistantText }] });
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
    outputPush(stream, queue, { type: 'run_item_stream_event', item: callItem });
    if (!definition) {
      state.input.push({ type: 'tool_result', id: event.id, output: `Unknown tool: ${event.name}` });
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
      outputPush(stream, queue, { type: 'run_item_stream_event', item: resultItem });
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
      outputPush(stream, queue, { type: 'run_item_stream_event', item: resultItem });
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
      state.pendingApproval = pending;
      stream.interruptions = [pending.interruption];
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
    outputPush(stream, queue, { type: 'run_item_stream_event', item: resultItem });
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

function outputPush(stream: AgentStream, queue: EventQueue, item: unknown): void {
  stream.output.push(item);
  stream.newItems.push(item);
  queue.push(item);
}

function finish(stream: AgentStream, state: RunState, queue: EventQueue): unknown {
  stream.history = state.history;
  stream.lastResponseId = state.responseId ?? null;
  queue.close();
  return { usage: state.usage, output: stream.output };
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
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

function normalizeInput(input: ProviderInput): StreamedModelTurnInput[] {
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: [{ type: 'text', text: input }] }];
  return (Array.isArray(input) ? input : [input]).flatMap((item) => normalizeInputItem(item));
}

function normalizeHistory(input: ProviderInput): ProviderInputItem[] {
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: input }];
  return Array.isArray(input) ? [...input] : [input];
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
        output: String(item.output ?? ''),
      },
    ];
  }
  if (item.type === 'reasoning') {
    return [{ type: 'reasoning', text: String(item.content ?? item.output ?? '') }];
  }
  const role = item.role === 'assistant' || item.role === 'system' ? item.role : 'user';
  const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? '');
  return [{ type: 'message', role, content: [{ type: 'text', text: content }] }];
}
