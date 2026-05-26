import type { OpenAIAgentClient } from '../lib/openai-agent-client.js';
import type { ILoggingService } from './service-interfaces.js';
import { ConversationStore } from './conversation-store.js';
import type { AgentInputItem } from '@openai/agents';
import {
  decideRetry,
  isTransientRetryableError,
  MAX_HALLUCINATION_RETRIES,
  MAX_TRANSIENT_RETRIES,
} from './conversation-retry-policy.js';
import type { ConversationEvent } from './conversation-events.js';
import type { CommandMessage } from '../tools/types.js';
import { type NormalizedUsage } from '../utils/token-usage.js';
import { getProvider } from '../providers/index.js';
import { ApprovalState } from './approval-state.js';
import type { ConversationTerminal, ReasoningEffortSetting } from '../contracts/conversation.js';
import type { ISettingsService } from './service-interfaces.js';
import { collectTerminalResult } from './terminal-result-collector.js';
import { getMethod } from './interruption-info.js';
import { createStreamAccumulator, processStreamEvents } from './stream-event-processor.js';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import { buildConversationResult, toTerminalEvent } from './conversation-result-builder.js';
import type { AgentStream } from './agent-stream.js';
import { normalizeUserTurn, type UserTurn } from '../types/user-turn.js';
import { collectDuplicateToolCallResultPairs, InputSurgeGuard } from './input-surge-guard.js';
import { LargeUncachedInputGuard, type LargeUncachedInputDecision } from './large-uncached-input-guard.js';
import {
  reconcileHistoryWithToolLedger,
  ToolExecutionLedger,
  type SavedToolExecution,
} from './tool-execution-ledger.js';
import type { LogEvent, StateSnapshot } from './conversation-log-events.js';
import { describeError } from '../utils/error-helpers.js';

const asRecordLocal = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const rawItemLocal = (item: unknown): Record<string, unknown> | null => {
  const rec = asRecordLocal(item);
  if (!rec) return null;
  return asRecordLocal(rec.rawItem) ?? rec;
};
const callIdOfLocal = (item: unknown): string | null => {
  const raw = rawItemLocal(item);
  const cid = raw?.callId ?? raw?.call_id ?? raw?.tool_call_id ?? raw?.toolCallId ?? raw?.id;
  return typeof cid === 'string' && cid ? cid : null;
};
const toolNameOfLocal = (item: unknown): string => {
  const raw = rawItemLocal(item);
  const name = raw?.name ?? asRecordLocal(item)?.name;
  return typeof name === 'string' && name ? name : 'unknown';
};
const outputOfLocal = (item: unknown): unknown => {
  const raw = rawItemLocal(item);
  return raw?.output ?? asRecordLocal(item)?.output;
};

export type { CommandMessage };
export type ConversationResult = ConversationTerminal;

const supportsConversationChaining = (providerId: string): boolean => {
  const providerDef = getProvider(providerId);
  return providerDef?.capabilities?.supportsConversationChaining ?? false;
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

type BuiltOutgoingInput = {
  streamInput: string | AgentInputItem | AgentInputItem[];
  inputSurgeKind: 'delta' | 'full_history';
  modeNoticeToPersist?: string;
};

type StreamHistorySource = 'startStream' | 'continueRunStream' | 'abortResolution';

const warnIfStreamHistoryReplayedTools = ({
  logger,
  sessionId,
  source,
  stream,
}: {
  logger: ILoggingService;
  sessionId: string;
  source: StreamHistorySource;
  stream: AgentStream;
}): void => {
  const streamRecord = stream as unknown as {
    history?: unknown;
    newItems?: unknown;
    state?: { _generatedItems?: unknown };
  };
  const history = asArray(streamRecord.history);
  const newItems = asArray(streamRecord.newItems);
  const stateGeneratedItems = asArray(streamRecord.state?._generatedItems);

  const historyDuplicates = collectDuplicateToolCallResultPairs(history);
  const newItemsDuplicates = collectDuplicateToolCallResultPairs(newItems);
  const stateGeneratedItemsDuplicates = collectDuplicateToolCallResultPairs(stateGeneratedItems);

  if (historyDuplicates.pairs === 0 && newItemsDuplicates.pairs === 0 && stateGeneratedItemsDuplicates.pairs === 0) {
    return;
  }

  logger.warn('Completed stream history contains replayed tool call/result pairs', {
    eventType: 'conversation.stream_history.replayed_tools',
    category: 'provider',
    phase: 'post_stream',
    sessionId,
    traceId: logger.getCorrelationId(),
    source,
    historyLength: history.length,
    newItemsLength: newItems.length,
    stateGeneratedItemsLength: stateGeneratedItems.length,
    historyDuplicatePairs: historyDuplicates.pairs,
    historyMaxCopies: historyDuplicates.maxCopies,
    newItemsDuplicatePairs: newItemsDuplicates.pairs,
    newItemsMaxCopies: newItemsDuplicates.maxCopies,
    stateGeneratedItemsDuplicatePairs: stateGeneratedItemsDuplicates.pairs,
    stateGeneratedItemsMaxCopies: stateGeneratedItemsDuplicates.maxCopies,
  });
};

export class ConversationSession {
  public readonly id: string;
  public readonly startedAt: string;
  private agentClient: OpenAIAgentClient;
  private logger: ILoggingService;
  private conversationStore: ConversationStore;
  private previousResponseId: string | null = null;
  private approvalState = new ApprovalState();
  private toolCallArgumentsById = new Map<string, unknown>();
  private emittedInvalidToolCallPackets = new Set<string>();
  private emittedToolStartedCallIds = new Set<string>();
  private shellAutoApproval: ShellAutoApprovalResolver;
  private approvalFlow: ApprovalFlowCoordinator;
  private inputSurgeGuard = new InputSurgeGuard();
  private largeUncachedInputGuard = new LargeUncachedInputGuard();
  private toolLedger = new ToolExecutionLedger();
  private generation = 0;

  private settingsService?: ISettingsService;
  private pendingModeNotice: string | null = null;
  private logSink: ((event: LogEvent) => void) | null = null;

  constructor(
    id: string,
    {
      agentClient,
      deps,
      sessionStartedAt,
    }: {
      agentClient: OpenAIAgentClient;
      deps: { logger: ILoggingService; settingsService?: ISettingsService };
      sessionStartedAt?: string;
    },
  ) {
    this.id = id;
    this.startedAt = sessionStartedAt ?? new Date().toISOString();
    this.agentClient = agentClient;
    this.logger = deps.logger;
    this.settingsService = deps.settingsService;
    this.conversationStore = new ConversationStore();
    this.shellAutoApproval = new ShellAutoApprovalResolver({
      conversationStore: this.conversationStore,
      agentClient: this.agentClient,
      logger: this.logger,
      settingsService: this.settingsService,
    });
    this.approvalFlow = new ApprovalFlowCoordinator({
      agentClient: this.agentClient,
      approvalState: this.approvalState,
      logger: this.logger,
      sessionId: this.id,
    });
  }

  #getTrafficMode(): string {
    if (!this.settingsService) return 'standard';
    if (this.settingsService.get<boolean>('app.orchestratorMode')) return 'orchestrator';
    if (this.settingsService.get<boolean>('app.liteMode')) return 'lite';
    if (this.settingsService.get<boolean>('app.planMode')) return 'plan';
    if (this.settingsService.get<boolean>('app.mentorMode')) return 'mentor';
    return 'standard';
  }

  #getModelForGuard(): string | null {
    return this.settingsService?.get<string>('agent.model') ?? null;
  }

  #getReasoningEffortForGuard(): string | null {
    return this.settingsService?.get<string>('agent.reasoningEffort') ?? null;
  }

  #getProviderForGuard(): string | null {
    const getProvider = getMethod<[], string>(this.agentClient, 'getProvider');
    return getProvider
      ? getProvider.call(this.agentClient)
      : this.settingsService?.get<string>('agent.provider') ?? null;
  }

  #makeUserInputItem(turn: UserTurn): AgentInputItem {
    const images = turn.images ?? [];
    if (images.length === 0) {
      return { role: 'user', type: 'message', content: turn.text ?? '' };
    }

    const content: any[] = [];
    if (turn.text) {
      content.push({ type: 'input_text', text: turn.text });
    }
    for (const image of images) {
      content.push({
        type: 'input_image',
        image: `data:${image.mimeType};base64,${image.data}`,
        detail: 'auto',
      });
    }

    return { role: 'user', type: 'message', content } as AgentInputItem;
  }

  #buildOutgoingInput(turn: UserTurn, { includeTurn }: { includeTurn: boolean }): BuiltOutgoingInput {
    const provider = this.#getProviderForGuard() ?? 'openai';
    const supportsChaining = supportsConversationChaining(provider);
    const history = this.conversationStore.getHistory();
    const outgoingHistory = includeTurn ? [...history, this.#makeUserInputItem(turn)] : history;
    const useChaining = supportsChaining && (!!this.previousResponseId || outgoingHistory.length <= 1);
    const notice = this.pendingModeNotice;
    const latestInput = outgoingHistory[outgoingHistory.length - 1] ?? turn.text;
    const chainedInput = turn.images?.length ? latestInput : turn.text;

    if (notice) {
      if (useChaining) {
        const userItem: AgentInputItem =
          typeof chainedInput === 'string' ? { role: 'user', type: 'message', content: chainedInput } : chainedInput;
        const noticeItem: AgentInputItem = { role: 'system', type: 'message', content: notice };
        return {
          streamInput: [noticeItem, userItem],
          inputSurgeKind: 'delta',
        };
      }

      const noticeItem: AgentInputItem = { role: 'user', type: 'message', content: notice };
      return {
        streamInput: [...outgoingHistory, noticeItem],
        inputSurgeKind: 'full_history',
        modeNoticeToPersist: notice,
      };
    }

    return {
      streamInput: useChaining ? (typeof chainedInput === 'string' ? chainedInput : [chainedInput]) : outgoingHistory,
      inputSurgeKind: useChaining ? 'delta' : 'full_history',
    };
  }

  previewLargeUncachedInput(input: string | UserTurn, now = Date.now()): LargeUncachedInputDecision {
    const turn = normalizeUserTurn(input);
    const { streamInput } = this.#buildOutgoingInput(turn, { includeTurn: true });
    return this.largeUncachedInputGuard.inspect({
      input: streamInput,
      now,
      provider: this.#getProviderForGuard(),
      model: this.#getModelForGuard(),
      reasoningEffort: this.#getReasoningEffortForGuard(),
      mode: this.#getTrafficMode(),
    });
  }

  #getFirstUserMessagePreview(currentTurn?: string): string {
    const [firstTurn] = this.conversationStore.listUserTurns();
    return firstTurn?.text ?? currentTurn ?? '';
  }

  #withTrafficContext<T>(currentTurn: string | undefined, fn: () => T): T {
    const runner = this.logger.runWithTrafficContext;
    if (!runner) return fn();
    return runner.call(
      this.logger,
      {
        sessionId: this.id,
        sessionStartedAt: this.startedAt,
        firstUserMessagePreview: this.#getFirstUserMessagePreview(currentTurn),
        mode: this.#getTrafficMode(),
        traceId: this.logger.getCorrelationId(),
      },
      fn,
    ) as T;
  }

  #isCurrentGeneration(gen: number): boolean {
    return gen === this.generation;
  }

  reset(): void {
    this.generation++;
    this.previousResponseId = null;
    this.conversationStore.clear();
    this.approvalState.clearPending();
    this.approvalState.consumeAborted();
    this.toolCallArgumentsById.clear();
    this.emittedToolStartedCallIds.clear();
    this.toolLedger = new ToolExecutionLedger();
    this.shellAutoApproval.clearCache();
    this.inputSurgeGuard.reset();
    this.largeUncachedInputGuard.reset();
    const clearConversations = getMethod<[], void>(this.agentClient, 'clearConversations');
    clearConversations?.call(this.agentClient);
  }

  undoLastUserTurn(): { text: string; imageCount: number } | null {
    const removed = this.conversationStore.removeLastUserTurn();
    if (removed === null) return null;
    this.generation++;
    this.previousResponseId = null;
    this.approvalState.clearPending();
    this.approvalState.consumeAborted();
    this.toolCallArgumentsById.clear();
    this.emittedToolStartedCallIds.clear();
    this.shellAutoApproval.clearCache();
    this.inputSurgeGuard.reset();
    this.largeUncachedInputGuard.markUndoOrRewind();
    this.#log({ type: 'undo', removedUserTurns: 1, snapshot: this.getCurrentSnapshot() });
    return removed;
  }

  listUserTurns(): { index: number; text: string; imageCount: number }[] {
    return this.conversationStore.listUserTurns();
  }

  undoNUserTurns(n: number): { text: string; imageCount: number } | null {
    const removed = this.conversationStore.removeNLastUserTurns(n);
    if (removed === null) return null;
    this.generation++;
    this.previousResponseId = null;
    this.approvalState.clearPending();
    this.approvalState.consumeAborted();
    this.toolCallArgumentsById.clear();
    this.emittedToolStartedCallIds.clear();
    this.shellAutoApproval.clearCache();
    this.inputSurgeGuard.reset();
    this.largeUncachedInputGuard.markUndoOrRewind();
    this.#log({ type: 'undo', removedUserTurns: n, snapshot: this.getCurrentSnapshot() });
    return removed;
  }

  setModel(model: string): void {
    this.agentClient.setModel(model);
  }

  setReasoningEffort(effort: ReasoningEffortSetting): void {
    const setReasoningEffort = getMethod<[ReasoningEffortSetting], void>(this.agentClient, 'setReasoningEffort');
    setReasoningEffort?.call(this.agentClient, effort);
  }

  setTemperature(temperature?: number): void {
    const setTemperature = getMethod<[number | undefined], void>(this.agentClient, 'setTemperature');
    setTemperature?.call(this.agentClient, temperature);
  }

  setProvider(provider: string): void {
    this.generation++;
    this.previousResponseId = null;
    this.approvalState.clearPending();
    this.approvalState.consumeAborted();
    this.toolCallArgumentsById.clear();
    this.emittedToolStartedCallIds.clear();
    this.shellAutoApproval.clearCache();
    this.inputSurgeGuard.reset();
    const clearConversations = getMethod<[], void>(this.agentClient, 'clearConversations');
    clearConversations?.call(this.agentClient);
    const setProvider = getMethod<[string], void>(this.agentClient, 'setProvider');
    setProvider?.call(this.agentClient, provider);
  }

  switchProvider(provider: string): void {
    this.setProvider(provider);
  }
  setRetryCallback(callback: () => void): void {
    if (typeof this.agentClient.setRetryCallback === 'function') {
      this.agentClient.setRetryCallback(callback);
    }
  }

  setLogSink(sink: ((event: LogEvent) => void) | null): void {
    this.logSink = sink;
  }

  getCurrentSnapshot(): StateSnapshot {
    const getProvider = getMethod<[], string>(this.agentClient, 'getProvider');
    const provider = getProvider
      ? getProvider.call(this.agentClient)
      : this.settingsService?.get<string>('agent.provider');
    const model = this.settingsService?.get<string>('agent.model');
    return {
      history: this.conversationStore.getHistory(),
      previousResponseId: this.previousResponseId,
      toolLedger: this.toolLedger.export(),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    };
  }

  #log(event: LogEvent): void {
    if (!this.logSink) return;
    try {
      this.logSink(event);
    } catch (err: any) {
      this.logger.warn('Conversation log sink threw', {
        eventType: 'conversation_log.sink_failed',
        category: 'persistence',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  #dispatchEventToLog(event: ConversationEvent): void {
    if (!this.logSink) return;
    switch (event.type) {
      case 'tool_started':
        this.#log({
          type: 'tool_started',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.arguments,
        });
        return;
      case 'command_message':
        this.#log({ type: 'command_message', message: event.message });
        return;
      case 'approval_required':
        this.#log({
          type: 'approval_required',
          approval: {
            toolName: event.approval.toolName,
            argumentsText: event.approval.argumentsText,
            agentName: event.approval.agentName,
            ...('callId' in event.approval && event.approval.callId ? { callId: event.approval.callId as string } : {}),
          },
        });
        return;
      case 'subagent_started':
        this.#log({
          type: 'subagent_started',
          agentId: event.agentId,
          role: event.role,
          task: event.task,
        });
        return;
      case 'subagent_completed':
        this.#log({ type: 'subagent_completed', result: event.result });
        return;
      case 'error':
        this.#log({ type: 'error', message: event.message, ...(event.kind ? { kind: event.kind } : {}) });
        return;
      case 'final': {
        const snapshot = this.getCurrentSnapshot();
        this.#log({
          type: 'assistant_final',
          message: {
            id: `bot-${snapshot.history.length}-${Date.now()}`,
            sender: 'bot',
            status: 'finalized',
            text: event.finalText,
            ...(event.reasoningText ? { reasoningText: event.reasoningText } : {}),
          },
          finalText: event.finalText,
          ...(event.reasoningText ? { reasoningText: event.reasoningText } : {}),
          ...(event.usage ? { usage: event.usage } : {}),
          snapshot,
        });
        return;
      }
      default:
        return;
    }
  }

  #dedupeToolStarted(event: ConversationEvent): ConversationEvent | null {
    if (event.type !== 'tool_started') {
      return event;
    }
    if (this.emittedToolStartedCallIds.has(event.toolCallId)) {
      return null;
    }
    this.emittedToolStartedCallIds.add(event.toolCallId);
    return event;
  }

  exportState(): {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger: SavedToolExecution[];
  } {
    return {
      history: this.conversationStore.getHistory(),
      previousResponseId: this.previousResponseId,
      toolLedger: this.toolLedger.export(),
    };
  }

  importState(state: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: SavedToolExecution[];
    updatedAt?: string;
  }): void {
    this.conversationStore.clear();
    this.toolLedger.import(state.toolLedger);
    const reconciled = reconcileHistoryWithToolLedger(state.history, state.toolLedger);
    if (reconciled.addedCompletedPairs > 0 || reconciled.droppedIncompleteCalls > 0) {
      this.logger.warn('Reconciled saved conversation history with tool execution ledger', {
        eventType: 'conversation.tool_ledger.reconciled',
        category: 'conversation',
        phase: 'resume',
        sessionId: this.id,
        addedCompletedPairs: reconciled.addedCompletedPairs,
        droppedIncompleteCalls: reconciled.droppedIncompleteCalls,
      });
    }
    for (const item of reconciled.history as import('@openai/agents').AgentInputItem[]) {
      this.conversationStore.addImportedItem(item);
    }
    this.previousResponseId = state.previousResponseId;
    this.emittedToolStartedCallIds.clear();
    this.inputSurgeGuard.reset();
    this.largeUncachedInputGuard.markResumedSession({
      updatedAtMs: state.updatedAt ? Date.parse(state.updatedAt) : null,
    });
    this.generation++;
  }

  addShellContext(historyText: string): void {
    this.conversationStore.addShellContext(historyText);
  }
  queueModeNotice(text: string): void {
    this.pendingModeNotice = text;
  }
  /**
   * Abort the current running operation
   */
  abort(): void {
    this.approvalFlow.abort();
  }

  /**
   * Phase 4: stream conversation events as an async iterator.
   *
   * This is the transport-friendly primitive that can later be bridged to SSE/WebSockets.
   */
  async *run(
    input: string | UserTurn,
    {
      hallucinationRetryCount = 0,
      flexServiceTierFallbackCount = 0,
      skipUserMessage = false,
    }: {
      hallucinationRetryCount?: number;
      flexServiceTierFallbackCount?: number;
      skipUserMessage?: boolean;
    } = {},
  ): AsyncIterable<ConversationEvent> {
    const gen = this.generation;
    let stream: AgentStream | null = null;
    const turn = normalizeUserTurn(input);
    const text = turn.text;
    let addedUserMessage = false;
    const ledgerSnapshot = this.toolLedger.export();
    this.toolLedger.beginTurn();
    try {
      this.logger.debug('Conversation stream start', {
        eventType: 'stream.started',
        category: 'stream',
        phase: 'request_start',
        sessionId: this.id,
        traceId: this.logger.getCorrelationId(),
      });
      const abortedContext = this.approvalFlow.consumeAborted();
      const shouldAddUserMessage = !skipUserMessage && !abortedContext;

      // Maintain canonical local history regardless of provider.
      if (shouldAddUserMessage) {
        this.conversationStore.addUserTurn(turn);
        addedUserMessage = true;
      } else if (abortedContext && !skipUserMessage) {
        // The UI appended a user message for this input, but the store will consume it
        // as fake tool output for the aborted approval rather than as a new user turn.
        // Signal the UI to mark it so /undo skips it.
        yield { type: 'user_message_consumed_for_abort' };
      }

      // If there's an aborted approval, we need to resolve it first.
      // The user's message is a new input, but the agent is stuck waiting for tool output.
      if (abortedContext) {
        this.logger.debug('Resolving aborted approval with fake execution', {
          message: text,
        });

        // Restore cached tool-call arguments captured before abort so continuation can attach them
        this.toolCallArgumentsById.clear();
        if (abortedContext.toolCallArgumentsById?.size) {
          for (const [key, value] of abortedContext.toolCallArgumentsById.entries()) {
            this.toolCallArgumentsById.set(key, value);
          }
        }

        const { removeInterceptor } = this.approvalFlow.prepareAbortResolution(abortedContext, text);

        try {
          const continuedStream = (await this.agentClient.continueRunStream(abortedContext.state, {
            previousResponseId: this.previousResponseId,
            sessionId: this.id,
          })) as AgentStream;

          const acc = createStreamAccumulator();
          acc.emittedCommandIds = new Set<string>(abortedContext.emittedCommandIds);
          for await (const event of processStreamEvents(
            continuedStream,
            acc,
            {
              toolCallArgumentsById: this.toolCallArgumentsById,
              emittedInvalidToolCallPackets: this.emittedInvalidToolCallPackets,
              preserveExistingToolArgs: true,
              onFunctionCallItem: (item) => this.toolLedger.recordFunctionCall(item),
              onFunctionResultItem: (item) => {
                this.toolLedger.recordFunctionResult(item);
                const cid = callIdOfLocal(item);
                if (cid && this.logSink) {
                  const entry = this.toolLedger.export().find((e) => e.callId === cid);
                  this.#log({
                    type: 'tool_result',
                    callId: cid,
                    toolName: entry?.toolName ?? toolNameOfLocal(item),
                    status: entry?.status === 'failed' || entry?.status === 'aborted' ? entry.status : 'completed',
                    output: entry?.output ?? outputOfLocal(item),
                    ...(entry?.historyItems ? { historyItems: entry.historyItems } : {}),
                  });
                }
              },
            },
            { logger: this.logger, sessionId: this.id },
          )) {
            const filtered = this.#dedupeToolStarted(event);
            if (filtered) yield filtered;
          }

          if (this.#isCurrentGeneration(gen)) {
            this.previousResponseId = continuedStream.lastResponseId ?? null;
            warnIfStreamHistoryReplayedTools({
              logger: this.logger,
              sessionId: this.id,
              source: 'abortResolution',
              stream: continuedStream,
            });
            this.conversationStore.updateFromResult(continuedStream);
          }

          // Check if another interruption occurred
          if (continuedStream.interruptions && continuedStream.interruptions.length > 0) {
            this.logger.warn('Another interruption occurred after fake execution - handling as approval');
            // Let the normal flow handle this
            const resolvedResult = yield* this.#buildAndResolve(
              continuedStream,
              acc.finalOutput,
              acc.reasoningOutput,
              acc.emittedCommandIds,
              acc.latestUsage,
            );
            yield toTerminalEvent(resolvedResult);
            return;
          }

          // Successfully resolved - agent should now have processed the fake rejection
          this.logger.debug('Fake execution completed, agent received rejection message');

          const resolvedResult = yield* this.#buildAndResolve(
            continuedStream,
            acc.finalOutput,
            acc.reasoningOutput,
            acc.emittedCommandIds,
            acc.latestUsage,
          );
          yield toTerminalEvent(resolvedResult);
          return;
        } catch (error) {
          this.logger.warn('Error resolving aborted approval with fake execution', {
            error: error instanceof Error ? error.message : String(error),
          });
          // Fall through to normal message flow
        } finally {
          // Always remove interceptor after use
          removeInterceptor();
        }
      }

      // Normal message flow
      // Use chaining mode only when the provider supports it AND either a valid
      // chain exists (previousResponseId is set) or there is no prior history to
      // resync (fresh start with just the current message). After undo the chain
      // is severed (previousResponseId = null) while prior turns remain in the
      // local store, so we fall back to full-history mode to re-establish context.
      const { streamInput, inputSurgeKind, modeNoticeToPersist } = this.#buildOutgoingInput(turn, {
        includeTurn: false,
      });
      if (this.pendingModeNotice) {
        this.pendingModeNotice = null;
      }
      if (modeNoticeToPersist) {
        // Persist the notice at the tail (append-only) rather than splicing
        // it before the last user turn or sending it as a one-shot item.
        // Mid-history insertion adds a stray ephemeral cache breakpoint (see
        // addCacheControlToLastTwoMessages) and a transient item makes
        // consecutive requests diverge at the tail — both break the
        // Claude/Qwen prompt cache. Appending keeps the cached prefix
        // byte-identical and only growing.
        this.conversationStore.addModeNotice(modeNoticeToPersist);
      }
      const surgeDecision = this.inputSurgeGuard.inspect(streamInput, { kind: inputSurgeKind });
      if (surgeDecision.action === 'block') {
        let droppedUserMessage: { text: string; imageCount: number } | undefined;
        if (addedUserMessage && this.#isCurrentGeneration(gen)) {
          this.conversationStore.removeLastUserMessage();
          droppedUserMessage = { text: turn.text, imageCount: turn.images?.length ?? 0 };
        }

        this.logger.warn('Input surge guard blocked provider request', {
          eventType: 'input_surge.blocked',
          category: 'provider',
          phase: 'request_start',
          sessionId: this.id,
          traceId: this.logger.getCorrelationId(),
          reason: surgeDecision.reason,
          stats: surgeDecision.stats,
          previousStats: surgeDecision.previousStats,
        });

        yield {
          type: 'error',
          kind: 'input_surge_guard',
          message: `${surgeDecision.reason} Request blocked to prevent runaway context growth. Try /undo or /clear, or compact the conversation history.`,
          ...(droppedUserMessage ? { droppedUserMessage } : {}),
        };
        return;
      }

      stream = (await this.agentClient.startStream(streamInput, {
        previousResponseId: inputSurgeKind === 'delta' ? this.previousResponseId : null,
        sessionId: this.id,
      })) as AgentStream;

      const acc = createStreamAccumulator();
      for await (const event of processStreamEvents(
        stream,
        acc,
        {
          toolCallArgumentsById: this.toolCallArgumentsById,
          emittedInvalidToolCallPackets: this.emittedInvalidToolCallPackets,
          preserveExistingToolArgs: false,
          onFunctionCallItem: (item) => this.toolLedger.recordFunctionCall(item),
          onFunctionResultItem: (item) => this.toolLedger.recordFunctionResult(item),
        },
        { logger: this.logger, sessionId: this.id },
      )) {
        const filtered = this.#dedupeToolStarted(event);
        if (filtered) yield filtered;
      }

      if (this.#isCurrentGeneration(gen)) {
        this.previousResponseId = stream.lastResponseId ?? null;
        warnIfStreamHistoryReplayedTools({
          logger: this.logger,
          sessionId: this.id,
          source: 'startStream',
          stream,
        });
        this.conversationStore.updateFromResult(stream);
      }

      const resolvedResult = yield* this.#buildAndResolve(
        stream,
        acc.finalOutput || undefined,
        acc.reasoningOutput || undefined,
        acc.emittedCommandIds,
        acc.latestUsage,
      );

      if (inputSurgeKind === 'delta') {
        this.inputSurgeGuard.recordSuccessfulInput(streamInput, { kind: inputSurgeKind });
      } else {
        this.inputSurgeGuard.recordSuccessfulInput(this.conversationStore.getHistory(), {
          kind: inputSurgeKind,
          previousInput: streamInput,
        });
      }
      this.largeUncachedInputGuard.recordSuccessfulInput({
        input: inputSurgeKind === 'delta' ? streamInput : this.conversationStore.getHistory(),
        now: Date.now(),
        provider: this.#getProviderForGuard(),
        model: this.#getModelForGuard(),
        reasoningEffort: this.#getReasoningEffortForGuard(),
        mode: this.#getTrafficMode(),
      });

      if (resolvedResult.type === 'approval_required') {
        this.logger.debug('Tool approval required', {
          eventType: 'approval.required',
          category: 'approval',
          phase: 'approval',
          sessionId: this.id,
          traceId: this.logger.getCorrelationId(),
          toolName: resolvedResult.approval.toolName,
        });
        yield toTerminalEvent(resolvedResult);
        return;
      }

      yield toTerminalEvent(resolvedResult);
    } catch (error) {
      const streamHistoryLength = Array.isArray((stream as any)?.history) ? (stream as any).history.length : 0;
      const shouldRetryWithoutFlex = getMethod<[unknown], boolean>(
        this.agentClient,
        'shouldRetryWithoutFlexServiceTier',
      )?.call(this.agentClient, error);

      if (shouldRetryWithoutFlex && flexServiceTierFallbackCount === 0) {
        this.logger.warn('Flex service tier timed out, retrying with standard service tier', {
          eventType: 'retry.flex_service_tier',
          category: 'retry',
          phase: 'retry',
          retryType: 'flex_service_tier',
          retryAttempt: 1,
          attempt: 1,
          maxRetries: 1,
          sessionId: this.id,
          traceId: this.logger.getCorrelationId(),
          errorMessage: error instanceof Error ? error.message : String(error),
        });

        yield {
          type: 'retry',
          toolName: 'service_tier',
          attempt: 1,
          maxRetries: 1,
          errorMessage: 'Flex service tier timed out. Falling back to standard service tier and retrying.',
          retryType: 'flex_service_tier',
        };

        getMethod<[], void>(this.agentClient, 'useStandardServiceTierForNextRequest')?.call(this.agentClient);
        this.toolLedger.import(ledgerSnapshot);
        yield* this.run(turn, {
          skipUserMessage: true,
          flexServiceTierFallbackCount: flexServiceTierFallbackCount + 1,
        });
        return;
      }

      const decision = decideRetry(error, hallucinationRetryCount, Boolean(stream), streamHistoryLength);

      if (decision.kind === 'retry') {
        this.logger.warn('Recoverable model error detected, retrying', {
          eventType: 'retry.model_error',
          category: 'retry',
          phase: 'retry',
          toolName: decision.logPayload.toolName,
          retryType: decision.logPayload.retryType,
          retryAttempt: decision.attempt,
          attempt: decision.attempt,
          maxRetries: MAX_HALLUCINATION_RETRIES,
          sessionId: this.id,
          traceId: this.logger.getCorrelationId(),
          errorMessage: decision.message,
        });

        yield decision.retryEvent;

        if (!this.#isCurrentGeneration(gen)) return;

        if (decision.hadStream && stream) {
          this.toolLedger.import(ledgerSnapshot);
          if (decision.shouldInjectErrorContext) {
            this.conversationStore.addErrorContext(decision.errorContextMessage);
          }
        } else {
          this.conversationStore.removeLastUserMessage();
        }

        yield* this.run(turn, decision.nextRunOptions);
        return;
      }

      // Drop the just-added user turn from the store before yielding so the
      // generator-cleanup path doesn't strand the removal — and so the error
      // event can carry the dropped text for UI restoration.
      let droppedUserMessage: { text: string; imageCount: number } | undefined;
      if (addedUserMessage && !stream && this.#isCurrentGeneration(gen)) {
        this.conversationStore.removeLastUserMessage();
        droppedUserMessage = { text: turn.text, imageCount: turn.images?.length ?? 0 };
      }
      if (stream && this.#isCurrentGeneration(gen)) {
        this.toolLedger.markOpenCallsAborted(error instanceof Error ? error.message : String(error));
        const recoverySummary = this.toolLedger.getRecoverySummary();
        if (recoverySummary) {
          yield {
            type: 'tool_recovery',
            recoveredCallIds: recoverySummary.recoveredCallIds,
            droppedCallIds: recoverySummary.droppedCallIds,
            message: recoverySummary.message,
          };
        }
      }
      yield {
        type: 'error',
        message: describeError(error),
        ...(droppedUserMessage ? { droppedUserMessage } : {}),
      };
      this.logger.error('Conversation stream error', {
        eventType: 'stream.failed',
        category: 'stream',
        phase: 'abort',
        sessionId: this.id,
        traceId: this.logger.getCorrelationId(),
        errorMessage: describeError(error),
      });
      throw error;
    }
  }

  /**
   * Phase 4: continue a session after an approval decision.
   *
   * Named as a string-literal because `continue` is a keyword.
   */
  async *['continue']({
    answer,
    rejectionReason,
  }: {
    answer: string;
    rejectionReason?: string;
  }): AsyncIterable<ConversationEvent> {
    const gen = this.generation;
    const plan = this.approvalFlow.prepareContinuation(answer, rejectionReason);
    if (!plan) {
      return;
    }

    const {
      pendingApprovalContext: { state, toolCallArgumentsById, emittedCommandIds: previouslyEmittedIds },
      toolStartedEvent,
      removeInterceptor,
    } = plan;

    if (toolStartedEvent) {
      const filtered = this.#dedupeToolStarted(toolStartedEvent);
      if (filtered) yield filtered;
    }

    // Restore cached tool-call arguments so continuation outputs can attach them
    this.toolCallArgumentsById.clear();
    if (toolCallArgumentsById?.size) {
      for (const [key, value] of toolCallArgumentsById.entries()) {
        this.toolCallArgumentsById.set(key, value);
      }
    }

    try {
      let transientRetryCount = 0;
      while (true) {
        try {
          const stream = (await this.agentClient.continueRunStream(state, {
            previousResponseId: this.previousResponseId,
            sessionId: this.id,
          })) as AgentStream;

          const acc = createStreamAccumulator();
          for await (const event of processStreamEvents(
            stream,
            acc,
            {
              toolCallArgumentsById: this.toolCallArgumentsById,
              emittedInvalidToolCallPackets: this.emittedInvalidToolCallPackets,
              preserveExistingToolArgs: true,
              onFunctionCallItem: (item) => this.toolLedger.recordFunctionCall(item),
              onFunctionResultItem: (item) => {
                this.toolLedger.recordFunctionResult(item);
                const cid = callIdOfLocal(item);
                if (cid && this.logSink) {
                  const entry = this.toolLedger.export().find((e) => e.callId === cid);
                  this.#log({
                    type: 'tool_result',
                    callId: cid,
                    toolName: entry?.toolName ?? toolNameOfLocal(item),
                    status: entry?.status === 'failed' || entry?.status === 'aborted' ? entry.status : 'completed',
                    output: entry?.output ?? outputOfLocal(item),
                    ...(entry?.historyItems ? { historyItems: entry.historyItems } : {}),
                  });
                }
              },
            },
            { logger: this.logger, sessionId: this.id },
          )) {
            const filtered = this.#dedupeToolStarted(event);
            if (filtered) yield filtered;
          }

          if (this.#isCurrentGeneration(gen)) {
            this.previousResponseId = stream.lastResponseId ?? null;
            warnIfStreamHistoryReplayedTools({
              logger: this.logger,
              sessionId: this.id,
              source: 'continueRunStream',
              stream,
            });
            this.conversationStore.updateFromResult(stream);
          }

          // Merge previously emitted command IDs with newly emitted ones
          // This prevents duplicates when result.history contains commands from the initial stream
          const allEmittedIds = new Set([...previouslyEmittedIds, ...acc.emittedCommandIds]);

          const resolvedResult = yield* this.#buildAndResolve(
            stream,
            acc.finalOutput || undefined,
            acc.reasoningOutput || undefined,
            allEmittedIds,
            acc.latestUsage,
          );

          if (resolvedResult.type === 'approval_required') {
            this.logger.debug('Tool approval required', {
              eventType: 'approval.required',
              category: 'approval',
              phase: 'approval',
              sessionId: this.id,
              traceId: this.logger.getCorrelationId(),
              toolName: resolvedResult.approval.toolName,
            });
            yield toTerminalEvent(resolvedResult);
            return;
          }

          yield toTerminalEvent(resolvedResult);
          return;
        } catch (error) {
          if (isTransientRetryableError(error) && transientRetryCount < MAX_TRANSIENT_RETRIES) {
            transientRetryCount++;
            const delay = Math.min(500 * Math.pow(2, transientRetryCount - 1), 30000);
            this.logger.warn('Transient error in continuation, retrying', {
              eventType: 'retry.transient',
              category: 'retry',
              phase: 'retry',
              retryType: 'upstream',
              retryAttempt: transientRetryCount,
              maxRetries: MAX_TRANSIENT_RETRIES,
              sessionId: this.id,
              traceId: this.logger.getCorrelationId(),
              errorMessage: error instanceof Error ? error.message : String(error),
              delayMs: delay,
            });
            yield {
              type: 'retry',
              toolName: 'continuation',
              attempt: transientRetryCount,
              maxRetries: MAX_TRANSIENT_RETRIES,
              errorMessage: error instanceof Error ? error.message : String(error),
              retryType: 'upstream',
            };
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      yield {
        type: 'error',
        message: describeError(error),
      };
      throw error;
    } finally {
      // Clean up interceptor if one was added for rejection reason
      removeInterceptor();
    }
  }

  async sendMessage(
    input: string | UserTurn,
    {
      onTextChunk,
      onReasoningChunk,
      onCommandMessage,
      onEvent,
      hallucinationRetryCount = 0,
    }: {
      onTextChunk?: (fullText: string, chunk: string) => void;
      onReasoningChunk?: (fullText: string, chunk: string) => void;
      onCommandMessage?: (message: CommandMessage) => void;
      onEvent?: (event: ConversationEvent) => void;
      hallucinationRetryCount?: number;
    } = {},
  ): Promise<ConversationResult> {
    const turn = normalizeUserTurn(input);
    return this.#withTrafficContext(turn.text, async () => {
      const wrappedOnEvent = (event: ConversationEvent) => {
        this.#dispatchEventToLog(event);
        onEvent?.(event);
      };
      getMethod<[((event: ConversationEvent) => void) | null], void>(this.agentClient, 'setSubagentEventSink')?.call(
        this.agentClient,
        wrappedOnEvent,
      );
      let result: ConversationResult;
      try {
        result = await collectTerminalResult(this.run(input, { hallucinationRetryCount }), {
          onTextChunk,
          onReasoningChunk,
          onCommandMessage,
          onEvent: wrappedOnEvent,
          getRawInterruption: () => this.approvalFlow.getPendingInterruption(),
          onFinalEvent: (event) => {
            this.logger.debug('sendMessage received final event', {
              sessionId: this.id,
              hasUsage: Boolean(event.usage),
              usage: event.usage,
            });
          },
        });
      } finally {
        getMethod<[((event: ConversationEvent) => void) | null], void>(this.agentClient, 'setSubagentEventSink')?.call(
          this.agentClient,
          null,
        );
      }

      if (result.type === 'response') {
        this.logger.debug('sendMessage returning response', {
          sessionId: this.id,
          hasUsage: Boolean(result.usage),
          usage: result.usage,
        });
      }

      return result;
    });
  }

  async handleApprovalDecision(
    answer: string,
    rejectionReason?: string,
    {
      onTextChunk,
      onReasoningChunk,
      onCommandMessage,
      onEvent,
    }: {
      onTextChunk?: (fullText: string, chunk: string) => void;
      onReasoningChunk?: (fullText: string, chunk: string) => void;
      onCommandMessage?: (message: CommandMessage) => void;
      onEvent?: (event: ConversationEvent) => void;
    } = {},
  ): Promise<ConversationResult | null> {
    if (!this.approvalFlow.getPending()) {
      return null;
    }

    this.#log({
      type: 'approval_resolved',
      answer: answer === 'y' ? 'y' : 'n',
      ...(rejectionReason ? { rejectionReason } : {}),
    });
    return this.#withTrafficContext(undefined, async () => {
      const wrappedOnEvent = (event: ConversationEvent) => {
        this.#dispatchEventToLog(event);
        onEvent?.(event);
      };
      getMethod<[((event: ConversationEvent) => void) | null], void>(this.agentClient, 'setSubagentEventSink')?.call(
        this.agentClient,
        wrappedOnEvent,
      );
      let result: ConversationResult | null;
      try {
        result = await collectTerminalResult(this['continue']({ answer, rejectionReason }), {
          onTextChunk,
          onReasoningChunk,
          onCommandMessage,
          onEvent: wrappedOnEvent,
          getRawInterruption: () => this.approvalFlow.getPendingInterruption(),
          onFinalEvent: (event) => {
            this.logger.debug('handleApprovalDecision received final event', {
              sessionId: this.id,
              hasUsage: Boolean(event.usage),
              usage: event.usage,
            });
          },
        });
      } finally {
        getMethod<[((event: ConversationEvent) => void) | null], void>(this.agentClient, 'setSubagentEventSink')?.call(
          this.agentClient,
          null,
        );
      }

      if (result.type === 'response') {
        this.logger.debug('handleApprovalDecision returning response', {
          sessionId: this.id,
          hasUsage: Boolean(result.usage),
          usage: result.usage,
        });
      }

      return result;
    });
  }

  async *#buildAndResolve(
    result: AgentStream,
    finalOutputOverride: string | undefined,
    reasoningOutputOverride: string | undefined,
    emittedCommandIds: Set<string> | undefined,
    usage: NormalizedUsage | undefined,
  ): AsyncGenerator<ConversationEvent, ConversationResult, void> {
    const outcome = await buildConversationResult(
      {
        result,
        finalOutputOverride,
        reasoningOutputOverride,
        emittedCommandIds,
        usage,
        toolCallArgumentsById: this.toolCallArgumentsById,
      },
      {
        approvalFlow: this.approvalFlow,
        shellAutoApproval: this.shellAutoApproval,
        logger: this.logger,
        sessionId: this.id,
      },
    );

    if (outcome.kind !== 'auto_approve') {
      return outcome.result;
    }

    let finalText = '';
    let reasoningText = '';
    let finalUsage: NormalizedUsage | undefined;
    let continuationApprovalUsage: NormalizedUsage | undefined;
    const commandMessages: CommandMessage[] = [];
    let approvalRequiredResult: ConversationResult | undefined;

    for await (const event of this['continue']({ answer: 'y' })) {
      if (event.type === 'approval_required') {
        continuationApprovalUsage = event.usage;
        // The continuation resumes the same live RunState, so its usage
        // accumulator is already cumulative for the whole run (it includes the
        // first, auto-approved turn). Prefer it directly; only fall back to the
        // first turn's usage if the continuation didn't report any.
        const mergedUsage = continuationApprovalUsage ?? usage;
        const usagePatch = mergedUsage && Object.keys(mergedUsage).length > 0 ? { usage: mergedUsage } : {};

        // collectTerminalResult returns on the first approval_required event, so
        // attach the run-cumulative usage onto the event itself.
        yield { ...event, ...usagePatch };

        approvalRequiredResult = {
          type: 'approval_required',
          approval: {
            ...event.approval,
            rawInterruption: this.approvalFlow.getPendingInterruption(),
          },
          ...usagePatch,
        };
      } else if (event.type === 'final') {
        finalText = event.finalText;
        reasoningText = event.reasoningText ?? '';
        finalUsage = event.usage;
        if (event.commandMessages) {
          commandMessages.push(...event.commandMessages);
        }
        yield event;
      } else {
        yield event;
      }
    }

    if (approvalRequiredResult) {
      return approvalRequiredResult;
    }

    // finalUsage comes from the continuation, which reused the same live
    // RunState and therefore already accumulated the first (auto-approved)
    // turn. Prefer it; fall back to the first turn's usage only when the
    // continuation produced none.
    const combinedUsage = finalUsage ?? usage;
    return {
      type: 'response',
      commandMessages,
      finalText: finalText || 'Done.',
      ...(reasoningText ? { reasoningText } : {}),
      ...(combinedUsage && Object.keys(combinedUsage).length > 0 ? { usage: combinedUsage } : {}),
    };
  }
}
