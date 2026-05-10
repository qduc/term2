import type { OpenAIAgentClient } from '../lib/openai-agent-client.js';
import type { ILoggingService } from './service-interfaces.js';
import { ConversationStore } from './conversation-store.js';
import { decideRetry, MAX_HALLUCINATION_RETRIES } from './conversation-retry-policy.js';
import type { ConversationEvent } from './conversation-events.js';
import type { CommandMessage } from '../tools/types.js';
import type { NormalizedUsage } from '../utils/token-usage.js';
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

export type { CommandMessage };
export type ConversationResult = ConversationTerminal;

const supportsConversationChaining = (providerId: string): boolean => {
  const providerDef = getProvider(providerId);
  return providerDef?.capabilities?.supportsConversationChaining ?? false;
};

export class ConversationSession {
  public readonly id: string;
  private agentClient: OpenAIAgentClient;
  private logger: ILoggingService;
  private conversationStore: ConversationStore;
  private previousResponseId: string | null = null;
  private approvalState = new ApprovalState();
  private toolCallArgumentsById = new Map<string, unknown>();
  private emittedInvalidToolCallPackets = new Set<string>();
  private shellAutoApproval: ShellAutoApprovalResolver;
  private approvalFlow: ApprovalFlowCoordinator;

  private settingsService?: ISettingsService;

  constructor(
    id: string,
    {
      agentClient,
      deps,
    }: { agentClient: OpenAIAgentClient; deps: { logger: ILoggingService; settingsService?: ISettingsService } },
  ) {
    this.id = id;
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

  reset(): void {
    this.previousResponseId = null;
    this.conversationStore.clear();
    this.approvalState.clearPending();
    this.approvalState.consumeAborted();
    this.toolCallArgumentsById.clear();
    this.shellAutoApproval.clearCache();
    const clearConversations = getMethod<[], void>(this.agentClient, 'clearConversations');
    clearConversations?.call(this.agentClient);
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
    const setProvider = getMethod<[string], void>(this.agentClient, 'setProvider');
    setProvider?.call(this.agentClient, provider);
  }
  setRetryCallback(callback: () => void): void {
    if (typeof this.agentClient.setRetryCallback === 'function') {
      this.agentClient.setRetryCallback(callback);
    }
  }

  addShellContext(historyText: string): void {
    this.conversationStore.addShellContext(historyText);
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
      skipUserMessage = false,
    }: {
      hallucinationRetryCount?: number;
      skipUserMessage?: boolean;
    } = {},
  ): AsyncIterable<ConversationEvent> {
    let stream: AgentStream | null = null;
    const turn = normalizeUserTurn(input);
    const text = turn.text;
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
          })) as AgentStream;

          const acc = createStreamAccumulator();
          acc.emittedCommandIds = new Set<string>(abortedContext.emittedCommandIds);
          yield* processStreamEvents(
            continuedStream,
            acc,
            {
              toolCallArgumentsById: this.toolCallArgumentsById,
              emittedInvalidToolCallPackets: this.emittedInvalidToolCallPackets,
              preserveExistingToolArgs: true,
            },
            { logger: this.logger, sessionId: this.id },
          );

          this.previousResponseId = continuedStream.lastResponseId ?? null;
          this.conversationStore.updateFromResult(continuedStream);

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
      const getProvider = getMethod<[], string>(this.agentClient, 'getProvider');
      const provider = getProvider ? getProvider.call(this.agentClient) : 'openai';

      const supportsChaining = supportsConversationChaining(provider);

      const history = this.conversationStore.getHistory();
      const latestInput = history[history.length - 1] ?? text;
      const chainedInput = turn.images?.length ? latestInput : text;
      stream = (await this.agentClient.startStream(supportsChaining ? chainedInput : history, {
        previousResponseId: this.previousResponseId,
      })) as AgentStream;

      const acc = createStreamAccumulator();
      yield* processStreamEvents(
        stream,
        acc,
        {
          toolCallArgumentsById: this.toolCallArgumentsById,
          emittedInvalidToolCallPackets: this.emittedInvalidToolCallPackets,
          preserveExistingToolArgs: false,
        },
        { logger: this.logger, sessionId: this.id },
      );

      this.previousResponseId = stream.lastResponseId ?? null;
      this.conversationStore.updateFromResult(stream);

      const resolvedResult = yield* this.#buildAndResolve(
        stream,
        acc.finalOutput || undefined,
        acc.reasoningOutput || undefined,
        acc.emittedCommandIds,
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
    } catch (error) {
      const streamHistoryLength = Array.isArray((stream as any)?.history) ? (stream as any).history.length : 0;
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

        if (decision.hadStream && stream) {
          this.conversationStore.updateFromResult(stream);
          if (decision.shouldInjectErrorContext) {
            this.conversationStore.addErrorContext(decision.errorContextMessage);
          }
        } else {
          this.conversationStore.removeLastUserMessage();
        }

        yield* this.run(turn, decision.nextRunOptions);
        return;
      }

      yield {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
      this.logger.error('Conversation stream error', {
        eventType: 'stream.failed',
        category: 'stream',
        phase: 'abort',
        sessionId: this.id,
        traceId: this.logger.getCorrelationId(),
        errorMessage: error instanceof Error ? error.message : String(error),
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
      yield toolStartedEvent;
    }

    // Restore cached tool-call arguments so continuation outputs can attach them
    this.toolCallArgumentsById.clear();
    if (toolCallArgumentsById?.size) {
      for (const [key, value] of toolCallArgumentsById.entries()) {
        this.toolCallArgumentsById.set(key, value);
      }
    }

    try {
      const stream = (await this.agentClient.continueRunStream(state, {
        previousResponseId: this.previousResponseId,
      })) as AgentStream;

      const acc = createStreamAccumulator();
      yield* processStreamEvents(
        stream,
        acc,
        {
          toolCallArgumentsById: this.toolCallArgumentsById,
          emittedInvalidToolCallPackets: this.emittedInvalidToolCallPackets,
          preserveExistingToolArgs: true,
        },
        { logger: this.logger, sessionId: this.id },
      );

      this.previousResponseId = stream.lastResponseId ?? null;
      this.conversationStore.updateFromResult(stream);

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
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
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
    const result = await collectTerminalResult(this.run(input, { hallucinationRetryCount }), {
      onTextChunk,
      onReasoningChunk,
      onCommandMessage,
      onEvent,
      getRawInterruption: () => this.approvalFlow.getPendingInterruption(),
      onFinalEvent: (event) => {
        this.logger.debug('sendMessage received final event', {
          sessionId: this.id,
          hasUsage: Boolean(event.usage),
          usage: event.usage,
        });
      },
    });

    if (result.type === 'response') {
      this.logger.debug('sendMessage returning response', {
        sessionId: this.id,
        hasUsage: Boolean(result.usage),
        usage: result.usage,
      });
    }

    return result;
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

    const result = await collectTerminalResult(this['continue']({ answer, rejectionReason }), {
      onTextChunk,
      onReasoningChunk,
      onCommandMessage,
      onEvent,
      getRawInterruption: () => this.approvalFlow.getPendingInterruption(),
      onFinalEvent: (event) => {
        this.logger.debug('handleApprovalDecision received final event', {
          sessionId: this.id,
          hasUsage: Boolean(event.usage),
          usage: event.usage,
        });
      },
    });

    if (result.type === 'response') {
      this.logger.debug('handleApprovalDecision returning response', {
        sessionId: this.id,
        hasUsage: Boolean(result.usage),
        usage: result.usage,
      });
    }

    return result;
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
    const commandMessages: CommandMessage[] = [];
    let approvalRequiredResult: ConversationResult | undefined;

    for await (const event of this['continue']({ answer: 'y' })) {
      yield event;

      if (event.type === 'approval_required') {
        approvalRequiredResult = {
          type: 'approval_required',
          approval: {
            ...event.approval,
            rawInterruption: this.approvalFlow.getPendingInterruption(),
          },
        };
      } else if (event.type === 'final') {
        finalText = event.finalText;
        reasoningText = event.reasoningText ?? '';
        finalUsage = event.usage;
        if (event.commandMessages) {
          commandMessages.push(...event.commandMessages);
        }
      }
    }

    if (approvalRequiredResult) {
      return approvalRequiredResult;
    }

    return {
      type: 'response',
      commandMessages,
      finalText: finalText || 'Done.',
      ...(reasoningText ? { reasoningText } : {}),
      ...(finalUsage ? { usage: finalUsage } : {}),
    };
  }
}
