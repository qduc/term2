import type { OpenAIAgentClient } from '../lib/openai-agent-client.js';
import { extractCommandMessages, markToolCallAsApprovalRejection } from '../utils/extract-command-messages.js';
import type { ILoggingService } from './service-interfaces.js';
import { ConversationStore } from './conversation-store.js';
import { ModelBehaviorError } from '@openai/agents';
import type { ConversationEvent } from './conversation-events.js';
import type { CommandMessage } from '../tools/types.js';
import { extractUsage, type NormalizedUsage } from '../utils/token-usage.js';
import { getProvider } from '../providers/index.js';
import { extractReasoningDelta, extractTextDelta } from './stream-event-parsing.js';
import { captureToolCallArguments, emitCommandMessagesFromItems } from './command-message-streaming.js';
import { ApprovalState } from './approval-state.js';
import { createInvalidToolCallDiagnostic } from './logging-contract.js';

export type { CommandMessage };

interface ApprovalResult {
  type: 'approval_required';
  approval: {
    agentName: string;
    toolName: string;
    argumentsText: string;
    rawInterruption: any;
    callId?: string;
  };
}

interface ResponseResult {
  type: 'response';
  commandMessages: CommandMessage[];
  finalText: string;
  reasoningText?: string;
  usage?: NormalizedUsage;
}

export type ConversationResult = ApprovalResult | ResponseResult;

const getCommandFromArgs = (args: unknown): string => {
  if (!args) {
    return '';
  }

  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      // Handle shell tool's command parameter
      if (parsed?.command) {
        return parsed.command;
      }
      // Fallback for old 'commands' array format
      if (Array.isArray(parsed?.commands)) {
        return parsed.commands.join('\n');
      }
      return JSON.stringify(parsed);
    } catch {
      return args;
    }
  }

  if (typeof args === 'object') {
    // Handle shell tool's command parameter
    const cmdFromObject = 'command' in args ? String(args.command) : undefined;
    // Fallback for old 'commands' array format
    if ('commands' in args && Array.isArray(args.commands)) {
      return (args.commands as string[]).join('\n');
    }
    let argsFromObject: string | undefined;
    if ('arguments' in args) {
      const rawArguments = (args as any).arguments;
      if (typeof rawArguments === 'string') {
        try {
          argsFromObject = JSON.stringify(JSON.parse(rawArguments));
        } catch {
          argsFromObject = String(rawArguments);
        }
      } else if (rawArguments !== undefined) {
        argsFromObject = String(rawArguments);
      }
    }
    return cmdFromObject ?? argsFromObject ?? JSON.stringify(args);
  }

  return String(args);
};

/**
 * Maximum number of retries when the model hallucinates a tool
 */
const MAX_HALLUCINATION_RETRIES = 2;

/**
 * Check if an error is a tool hallucination error (model called a non-existent tool)
 */
const isToolHallucinationError = (error: unknown): boolean => {
  if (!(error instanceof ModelBehaviorError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('tool') && message.includes('not found');
};

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
  private textDeltaCount = 0;
  private reasoningDeltaCount = 0;
  private toolCallArgumentsById = new Map<string, unknown>();
  private lastEventType: string | null = null;
  private eventTypeCount = 0;
  private emittedInvalidToolCallPackets = new Set<string>();
  // private logStreamEvent = (eventType: string, eventData: any) => {
  // 	if (eventData.item) {
  // 		eventType = eventData.item.type;
  // 		eventData = eventData.item.rawItem;
  // 		// this.logStreamEvent(eventType, eventData);
  // 	}
  //
  // 	// Deduplicate consecutive identical event types
  //     if (eventType !== this.lastEventType) {
  //         if (this.lastEventType !== null && this.eventTypeCount > 0) {
  //             this.logger.debug('Stream event summary', {
  //                 eventType: this.lastEventType,
  //                 count: this.eventTypeCount,
  //             });
  //         }
  //         this.lastEventType = eventType;
  //         this.eventTypeCount = 1;
  //         // Log the first occurrence with details
  //         this.logger.debug('Stream event', {
  //             eventType,
  //             ...eventData,
  //         });
  //     } else {
  //         this.eventTypeCount++;
  //     }
  // };
  private flushStreamEventLog = () => {
    if (this.lastEventType !== null && this.eventTypeCount > 1) {
      this.logger.debug('Stream event summary', {
        eventType: this.lastEventType,
        count: this.eventTypeCount,
      });
    }
    this.lastEventType = null;
    this.eventTypeCount = 0;
  };

  constructor(
    id: string,
    { agentClient, deps }: { agentClient: OpenAIAgentClient; deps: { logger: ILoggingService } },
  ) {
    this.id = id;
    this.agentClient = agentClient;
    this.logger = deps.logger;
    this.conversationStore = new ConversationStore();
  }

  reset(): void {
    this.previousResponseId = null;
    this.conversationStore.clear();
    this.approvalState.clearPending();
    this.approvalState.consumeAborted();
    this.toolCallArgumentsById.clear();
    if (typeof (this.agentClient as any).clearConversations === 'function') {
      (this.agentClient as any).clearConversations();
    }
  }

  setModel(model: string): void {
    this.agentClient.setModel(model);
  }

  setReasoningEffort(effort: any): void {
    if (typeof this.agentClient.setReasoningEffort === 'function') {
      this.agentClient.setReasoningEffort(effort);
    }
  }

  setTemperature(temperature: any): void {
    if (typeof (this.agentClient as any).setTemperature === 'function') {
      (this.agentClient as any).setTemperature(temperature);
    }
  }

  setProvider(provider: string): void {
    if (typeof this.agentClient.setProvider === 'function') {
      (this.agentClient as any).setProvider(provider);
    }
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
    this.agentClient.abort();
    // Save pending approval context so we can handle it in the next message
    if (this.approvalState.abortPending()) {
      this.logger.debug('Aborted approval - will handle rejection on next message', {
        eventType: 'approval.aborted',
        category: 'approval',
        phase: 'abort',
        sessionId: this.id,
        traceId: this.logger.getCorrelationId(),
      });
    }
  }

  /**
   * Phase 4: stream conversation events as an async iterator.
   *
   * This is the transport-friendly primitive that can later be bridged to SSE/WebSockets.
   */
  async *run(
    text: string,
    {
      hallucinationRetryCount = 0,
      skipUserMessage = false,
    }: {
      hallucinationRetryCount?: number;
      skipUserMessage?: boolean;
    } = {},
  ): AsyncIterable<ConversationEvent> {
    let stream: any = null;
    try {
      this.logger.info('Conversation stream start', {
        eventType: 'stream.started',
        category: 'stream',
        phase: 'request_start',
        sessionId: this.id,
        traceId: this.logger.getCorrelationId(),
      });
      const abortedContext = this.approvalState.consumeAborted();
      const shouldAddUserMessage = !skipUserMessage && !abortedContext;

      // Maintain canonical local history regardless of provider.
      if (shouldAddUserMessage) {
        this.conversationStore.addUserMessage(text);
      }

      // If there's an aborted approval, we need to resolve it first.
      // The user's message is a new input, but the agent is stuck waiting for tool output.
      if (abortedContext) {
        this.logger.debug('Resolving aborted approval with fake execution', {
          message: text,
        });

        const { state, interruption, emittedCommandIds, toolCallArgumentsById } = abortedContext;

        // Restore cached tool-call arguments captured before abort so continuation can attach them
        this.toolCallArgumentsById.clear();
        if (toolCallArgumentsById?.size) {
          for (const [key, value] of toolCallArgumentsById.entries()) {
            this.toolCallArgumentsById.set(key, value);
          }
        }

        // Add interceptor for this tool execution
        const toolName = interruption.name ?? 'unknown';
        const expectedCallId = (interruption as any).rawItem?.callId ?? (interruption as any).callId;
        const rejectionMessage = `Tool execution was not approved. User provided new input instead: ${text}`;

        const removeInterceptor = this.agentClient.addToolInterceptor(
          async (name: string, _params: any, toolCallId?: string) => {
            // Match both tool name and call ID for stricter matching
            if (name === toolName && (!expectedCallId || toolCallId === expectedCallId)) {
              markToolCallAsApprovalRejection(toolCallId ?? expectedCallId);
              return rejectionMessage;
            }
            return null;
          },
        );

        state.approve(interruption);

        try {
          const stream = await this.agentClient.continueRunStream(state, {
            previousResponseId: this.previousResponseId,
          });

          const acc = {
            finalOutput: '',
            reasoningOutput: '',
            emittedCommandIds: new Set<string>(emittedCommandIds),
            latestUsage: undefined as NormalizedUsage | undefined,
          };
          yield* this.#streamEvents(stream, acc, {
            preserveExistingToolArgs: true,
          });

          this.previousResponseId = stream.lastResponseId;
          this.conversationStore.updateFromResult(stream);

          // Check if another interruption occurred
          if (stream.interruptions && stream.interruptions.length > 0) {
            this.logger.warn('Another interruption occurred after fake execution - handling as approval');
            // Let the normal flow handle this
            const result = this.#buildResult(
              stream,
              acc.finalOutput,
              acc.reasoningOutput,
              acc.emittedCommandIds,
              acc.latestUsage,
            );
            // Re-emit the terminal event explicitly.
            if (result.type === 'approval_required') {
              const interruption = result.approval.rawInterruption;
              const callId =
                interruption?.rawItem?.callId ??
                interruption?.callId ??
                interruption?.call_id ??
                interruption?.tool_call_id ??
                interruption?.toolCallId ??
                interruption?.id;
              yield {
                type: 'approval_required',
                approval: {
                  agentName: result.approval.agentName,
                  toolName: result.approval.toolName,
                  argumentsText: result.approval.argumentsText,
                  ...(callId ? { callId: String(callId) } : {}),
                },
              };
            } else {
              yield {
                type: 'final',
                finalText: result.finalText,
                ...(result.reasoningText ? { reasoningText: result.reasoningText } : {}),
                ...(result.commandMessages?.length ? { commandMessages: result.commandMessages } : {}),
                ...(result.usage ? { usage: result.usage } : {}),
              };
            }
            return;
          }

          // Successfully resolved - agent should now have processed the fake rejection
          this.logger.debug('Fake execution completed, agent received rejection message');

          const result = this.#buildResult(
            stream,
            acc.finalOutput,
            acc.reasoningOutput,
            acc.emittedCommandIds,
            acc.latestUsage,
          );
          if (result.type === 'approval_required') {
            const interruption = result.approval.rawInterruption;
            const callId =
              interruption?.rawItem?.callId ??
              interruption?.callId ??
              interruption?.call_id ??
              interruption?.tool_call_id ??
              interruption?.toolCallId ??
              interruption?.id;
            yield {
              type: 'approval_required',
              approval: {
                agentName: result.approval.agentName,
                toolName: result.approval.toolName,
                argumentsText: result.approval.argumentsText,
                ...(callId ? { callId: String(callId) } : {}),
              },
            };
          } else {
            yield {
              type: 'final',
              finalText: result.finalText,
              ...(result.reasoningText ? { reasoningText: result.reasoningText } : {}),
              ...(result.commandMessages?.length ? { commandMessages: result.commandMessages } : {}),
              ...(result.usage ? { usage: result.usage } : {}),
            };
          }
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
      const provider =
        typeof (this.agentClient as any).getProvider === 'function'
          ? (this.agentClient as any).getProvider()
          : 'openai';

      const supportsChaining = supportsConversationChaining(provider);

      stream = await this.agentClient.startStream(
        supportsChaining ? text : (this.conversationStore.getHistory() as any),
        {
          previousResponseId: this.previousResponseId,
        },
      );

      const acc = {
        finalOutput: '',
        reasoningOutput: '',
        emittedCommandIds: new Set<string>(),
        latestUsage: undefined as NormalizedUsage | undefined,
      };
      yield* this.#streamEvents(stream, acc, {
        preserveExistingToolArgs: false,
      });

      this.previousResponseId = stream.lastResponseId;
      this.conversationStore.updateFromResult(stream);

      // Build terminal event (approval_required or final)
      const result = this.#buildResult(
        stream,
        acc.finalOutput || undefined,
        acc.reasoningOutput || undefined,
        acc.emittedCommandIds,
        acc.latestUsage,
      );

      if (result.type === 'approval_required') {
        this.logger.info('Tool approval required', {
          eventType: 'approval.required',
          category: 'approval',
          phase: 'approval',
          sessionId: this.id,
          traceId: this.logger.getCorrelationId(),
          toolName: result.approval.toolName,
        });
        const interruption = result.approval.rawInterruption;
        const callId =
          interruption?.rawItem?.callId ??
          interruption?.callId ??
          interruption?.call_id ??
          interruption?.tool_call_id ??
          interruption?.toolCallId ??
          interruption?.id;
        yield {
          type: 'approval_required',
          approval: {
            agentName: result.approval.agentName,
            toolName: result.approval.toolName,
            argumentsText: result.approval.argumentsText,
            ...(callId ? { callId: String(callId) } : {}),
          },
        };
        return;
      }

      yield {
        type: 'final',
        finalText: result.finalText,
        ...(result.reasoningText ? { reasoningText: result.reasoningText } : {}),
        ...(result.commandMessages?.length ? { commandMessages: result.commandMessages } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    } catch (error) {
      // Handle tool hallucination: model called a non-existent tool
      if (isToolHallucinationError(error) && hallucinationRetryCount < MAX_HALLUCINATION_RETRIES) {
        const toolName =
          error instanceof Error ? error.message.match(/Tool (\S+) not found/)?.[1] || 'unknown' : 'unknown';

        this.logger.warn('Tool hallucination detected, retrying', {
          eventType: 'retry.hallucination',
          category: 'retry',
          phase: 'retry',
          toolName,
          retryType: 'hallucination',
          retryAttempt: hallucinationRetryCount + 1,
          attempt: hallucinationRetryCount + 1,
          maxRetries: MAX_HALLUCINATION_RETRIES,
          sessionId: this.id,
          traceId: this.logger.getCorrelationId(),
          errorMessage: error instanceof Error ? error.message : String(error),
        });

        yield {
          type: 'retry',
          toolName,
          attempt: hallucinationRetryCount + 1,
          maxRetries: MAX_HALLUCINATION_RETRIES,
          errorMessage: error instanceof Error ? error.message : String(error),
        };

        if (stream) {
          // Update conversation store with partial results (successful tool calls)
          this.conversationStore.updateFromResult(stream);
          // Retry from current state without re-adding user message
          yield* this.run(text, {
            hallucinationRetryCount: hallucinationRetryCount + 1,
            skipUserMessage: true,
          });
        } else {
          // Failed to start stream at all - clean slate retry
          this.conversationStore.removeLastUserMessage();
          yield* this.run(text, {
            hallucinationRetryCount: hallucinationRetryCount + 1,
            // skipUserMessage defaults to false, so user message is re-added
          });
        }
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
    const pendingApprovalContext = this.approvalState.getPending();
    if (!pendingApprovalContext) {
      return;
    }

    const {
      state,
      interruption,
      emittedCommandIds: previouslyEmittedIds,
      toolCallArgumentsById,
    } = pendingApprovalContext;

    let removeInterceptor: (() => void) | null = null;

    if (answer === 'y') {
      this.logger.info('Tool approval granted', {
        eventType: 'approval.granted',
        category: 'approval',
        phase: 'approval',
        sessionId: this.id,
        traceId: this.logger.getCorrelationId(),
      });
      state.approve(interruption);
    } else {
      const toolName = interruption.name ?? 'unknown';
      const expectedCallId = (interruption as any).rawItem?.callId ?? (interruption as any).callId;
      const rejectionMessage = rejectionReason
        ? `Tool execution was not approved. User's reason: ${rejectionReason}`
        : 'Tool execution was not approved.';

      if (typeof this.agentClient.addToolInterceptor === 'function') {
        const removeInterceptor = this.agentClient.addToolInterceptor(
          async (name: string, _params: any, toolCallId?: string) => {
            if (name === toolName && (!expectedCallId || toolCallId === expectedCallId)) {
              markToolCallAsApprovalRejection(toolCallId ?? expectedCallId);
              return rejectionMessage;
            }
            return null;
          },
        );

        // Approve to continue but interceptor will return rejection message
        state.approve(interruption);

        // Store interceptor cleanup for after stream
        this.approvalState.setPendingRemoveInterceptor(removeInterceptor);
      } else {
        // Fallback for clients without tool interceptors
        state.reject(interruption);
      }

      this.logger.info('Tool approval rejected', {
        eventType: 'approval.rejected',
        category: 'approval',
        phase: 'approval',
        sessionId: this.id,
        traceId: this.logger.getCorrelationId(),
      });
    }

    removeInterceptor = this.approvalState.getPending()?.removeInterceptor ?? null;

    // Restore cached tool-call arguments so continuation outputs can attach them
    this.toolCallArgumentsById.clear();
    if (toolCallArgumentsById?.size) {
      for (const [key, value] of toolCallArgumentsById.entries()) {
        this.toolCallArgumentsById.set(key, value);
      }
    }

    try {
      const stream = await this.agentClient.continueRunStream(state, {
        previousResponseId: this.previousResponseId,
      });

      const acc = {
        finalOutput: '',
        reasoningOutput: '',
        emittedCommandIds: new Set<string>(),
        latestUsage: undefined as NormalizedUsage | undefined,
      };
      yield* this.#streamEvents(stream, acc, {
        preserveExistingToolArgs: true,
      });

      this.previousResponseId = stream.lastResponseId;
      this.conversationStore.updateFromResult(stream);

      // Merge previously emitted command IDs with newly emitted ones
      // This prevents duplicates when result.history contains commands from the initial stream
      const allEmittedIds = new Set([...previouslyEmittedIds, ...acc.emittedCommandIds]);

      const result = this.#buildResult(
        stream,
        acc.finalOutput || undefined,
        acc.reasoningOutput || undefined,
        allEmittedIds,
        acc.latestUsage,
      );

      if (result.type === 'approval_required') {
        this.logger.info('Tool approval required', {
          eventType: 'approval.required',
          category: 'approval',
          phase: 'approval',
          sessionId: this.id,
          traceId: this.logger.getCorrelationId(),
          toolName: result.approval.toolName,
        });
        const interruption = result.approval.rawInterruption;
        const callId =
          interruption?.rawItem?.callId ??
          interruption?.callId ??
          interruption?.call_id ??
          interruption?.tool_call_id ??
          interruption?.toolCallId ??
          interruption?.id;
        yield {
          type: 'approval_required',
          approval: {
            agentName: result.approval.agentName,
            toolName: result.approval.toolName,
            argumentsText: result.approval.argumentsText,
            ...(callId ? { callId: String(callId) } : {}),
          },
        };
        return;
      }

      yield {
        type: 'final',
        finalText: result.finalText,
        ...(result.reasoningText ? { reasoningText: result.reasoningText } : {}),
        ...(result.commandMessages?.length ? { commandMessages: result.commandMessages } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    } finally {
      // Clean up interceptor if one was added for rejection reason
      removeInterceptor?.();
    }
  }

  async sendMessage(
    text: string,
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
    let finalText = '';
    let reasoningText = '';
    const commandMessages: CommandMessage[] = [];
    let usage: NormalizedUsage | undefined;
    let sawTerminalEvent: ConversationEvent | null = null;

    for await (const event of this.run(text, { hallucinationRetryCount })) {
      onEvent?.(event);

      switch (event.type) {
        case 'text_delta': {
          const full = event.fullText ?? '';
          onTextChunk?.(full, event.delta);
          break;
        }
        case 'reasoning_delta': {
          const full = event.fullText ?? '';
          onReasoningChunk?.(full, event.delta);
          break;
        }
        case 'command_message': {
          onCommandMessage?.(event.message as any);
          break;
        }
        case 'approval_required': {
          sawTerminalEvent = event;
          // pendingApprovalContext is set inside #buildResult during run()
          const rawInterruption = this.approvalState.getPending()?.interruption;
          return {
            type: 'approval_required',
            approval: {
              agentName: event.approval.agentName,
              toolName: event.approval.toolName,
              argumentsText: event.approval.argumentsText,
              rawInterruption,
            },
          };
        }
        case 'final': {
          sawTerminalEvent = event;
          finalText = event.finalText;
          reasoningText = event.reasoningText ?? '';
          usage = event.usage;
          this.logger.debug('sendMessage received final event', {
            sessionId: this.id,
            hasUsage: Boolean(event.usage),
            usage: event.usage,
          });
          if (event.commandMessages?.length) {
            for (const msg of event.commandMessages) {
              commandMessages.push(msg as any);
            }
          }
          break;
        }
        case 'error': {
          // Preserve legacy behavior (throwing) by throwing after the stream ends.
          break;
        }
        default:
          break;
      }
    }

    // If we didn't see a terminal event, fall back to the legacy default.
    if (!sawTerminalEvent) {
      finalText = finalText || 'Done.';
    }

    const response: ConversationResult = {
      type: 'response',
      commandMessages,
      finalText: finalText || 'Done.',
      ...(reasoningText ? { reasoningText } : {}),
      ...(usage ? { usage } : {}),
    };
    this.logger.debug('sendMessage returning response', {
      sessionId: this.id,
      hasUsage: Boolean(usage),
      usage,
    });
    return response;
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
    if (!this.approvalState.getPending()) {
      return null;
    }

    let finalText = '';
    let reasoningText = '';
    const commandMessages: CommandMessage[] = [];
    let usage: NormalizedUsage | undefined;
    let sawTerminalEvent: ConversationEvent | null = null;

    for await (const event of this['continue']({ answer, rejectionReason })) {
      onEvent?.(event);

      switch (event.type) {
        case 'text_delta': {
          const full = event.fullText ?? '';
          onTextChunk?.(full, event.delta);
          break;
        }
        case 'reasoning_delta': {
          const full = event.fullText ?? '';
          onReasoningChunk?.(full, event.delta);
          break;
        }
        case 'command_message': {
          onCommandMessage?.(event.message as any);
          break;
        }
        case 'approval_required': {
          sawTerminalEvent = event;
          const rawInterruption = this.approvalState.getPending()?.interruption;
          return {
            type: 'approval_required',
            approval: {
              agentName: event.approval.agentName,
              toolName: event.approval.toolName,
              argumentsText: event.approval.argumentsText,
              rawInterruption,
            },
          };
        }
        case 'final': {
          sawTerminalEvent = event;
          finalText = event.finalText;
          reasoningText = event.reasoningText ?? '';
          usage = event.usage;
          this.logger.debug('handleApprovalDecision received final event', {
            sessionId: this.id,
            hasUsage: Boolean(event.usage),
            usage: event.usage,
          });
          if (event.commandMessages?.length) {
            for (const msg of event.commandMessages) {
              commandMessages.push(msg as any);
            }
          }
          break;
        }
        case 'error': {
          break;
        }
        default:
          break;
      }
    }

    if (!sawTerminalEvent) {
      const response: ConversationResult = {
        type: 'response',
        commandMessages,
        finalText: finalText || 'Done.',
        ...(reasoningText ? { reasoningText } : {}),
        ...(usage ? { usage } : {}),
      };
      this.logger.debug('handleApprovalDecision returning response', {
        sessionId: this.id,
        hasUsage: Boolean(usage),
        usage,
      });
      return response;
    }

    const response: ConversationResult = {
      type: 'response',
      commandMessages,
      finalText: finalText || 'Done.',
      ...(reasoningText ? { reasoningText } : {}),
      ...(usage ? { usage } : {}),
    };
    this.logger.debug('handleApprovalDecision returning response', {
      sessionId: this.id,
      hasUsage: Boolean(usage),
      usage,
    });
    return response;
  }

  async *#streamEvents(
    stream: any,
    acc: {
      finalOutput: string;
      reasoningOutput: string;
      emittedCommandIds: Set<string>;
      latestUsage?: NormalizedUsage;
    },
    { preserveExistingToolArgs }: { preserveExistingToolArgs: boolean },
  ): AsyncIterable<ConversationEvent> {
    const toolCallArgumentsById = this.toolCallArgumentsById;
    if (!preserveExistingToolArgs) {
      toolCallArgumentsById.clear();
    }

    this.textDeltaCount = 0;
    this.reasoningDeltaCount = 0;

    const emitText = (delta: string) => {
      if (!delta) {
        return null;
      }
      acc.finalOutput += delta;
      this.textDeltaCount++;
      return {
        type: 'text_delta' as const,
        delta,
        fullText: acc.finalOutput,
      };
    };

    const emitReasoning = (delta: string) => {
      if (!delta || delta.replaceAll('\n', '') === '') {
        return null;
      }
      acc.reasoningOutput += delta;
      this.reasoningDeltaCount++;
      return {
        type: 'reasoning_delta' as const,
        delta,
        fullText: acc.reasoningOutput,
      };
    };

    for await (const event of stream) {
      // Extract usage if present in any of the common locations
      const usage = extractUsage(event);
      if (usage) {
        acc.latestUsage = usage;
        this.logger.debug('Usage extracted from stream event', {
          sessionId: this.id,
          source: 'stream_event',
          eventType: event?.type ?? event?.data?.type ?? 'unknown',
          usage,
        });
      }

      // Log event type with deduplication for ordering understanding

      const delta1 = extractTextDelta(event);
      if (delta1) {
        const e = emitText(delta1);
        if (e) yield e;
      }
      if (event?.data) {
        const delta2 = extractTextDelta(event.data);
        if (delta2) {
          const e = emitText(delta2);
          if (e) yield e;
        }
      }

      // Handle reasoning items
      const reasoningDelta = extractReasoningDelta(event);
      if (reasoningDelta) {
        const e = emitReasoning(reasoningDelta);
        if (e) yield e;
      }

      const maybeEmitCommandMessagesFromItems = (items: any[]) =>
        emitCommandMessagesFromItems(items, {
          toolCallArgumentsById,
          emittedCommandIds: acc.emittedCommandIds,
        });

      if (event?.type === 'run_item_stream_event') {
        captureToolCallArguments(event.item, toolCallArgumentsById);

        // Emit tool_started event when a function_call is detected
        const rawItem = event.item?.rawItem ?? event.item;
        if (rawItem?.type === 'function_call') {
          const callId = rawItem.callId ?? rawItem.call_id ?? rawItem.tool_call_id ?? rawItem.toolCallId ?? rawItem.id;
          if (callId) {
            const toolName = rawItem.name ?? event.item?.name;
            const args = rawItem.arguments ?? rawItem.args ?? event.item?.arguments ?? event.item?.args;

            // Providers sometimes surface arguments as a JSON string.
            // Normalize here so downstream UI (pending/running display)
            // can reliably render parameters.
            const normalizedArgs = (() => {
              if (typeof args !== 'string') {
                return args;
              }

              const trimmed = args.trim();
              if (!trimmed) {
                return args;
              }

              try {
                return JSON.parse(trimmed);
              } catch {
                if (
                  (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
                  !this.emittedInvalidToolCallPackets.has(String(callId))
                ) {
                  this.emittedInvalidToolCallPackets.add(String(callId));
                  const diagnostic = createInvalidToolCallDiagnostic({
                    toolName: toolName ?? 'unknown',
                    toolCallId: String(callId),
                    rawPayload: trimmed,
                    normalizedToolCall: {
                      toolName: toolName ?? 'unknown',
                      toolCallId: String(callId),
                      arguments: args,
                    },
                    validationErrors: ['arguments must be valid JSON'],
                    traceId: this.logger.getCorrelationId() ?? 'trace-unknown',
                    retryContext: {
                      sessionId: this.id,
                    },
                  });

                  this.logger.error('Invalid tool call argument payload', {
                    ...diagnostic,
                    sessionId: this.id,
                    messageId: String(callId),
                  });
                }
                return args;
              }
            })();
            yield {
              type: 'tool_started' as const,
              toolCallId: callId,
              toolName: toolName ?? 'unknown',
              arguments: normalizedArgs,
            };
            this.logger.info('Tool execution started', {
              eventType: 'tool_call.execution_started',
              category: 'tool',
              phase: 'execution',
              sessionId: this.id,
              traceId: this.logger.getCorrelationId(),
              toolName: toolName ?? 'unknown',
              toolCallId: String(callId),
              messageId: String(callId),
            });
          }
        }

        for (const e of maybeEmitCommandMessagesFromItems([event.item])) {
          yield e;
        }
      } else if (event?.type === 'tool_call_output_item' || event?.rawItem?.type === 'function_call_output') {
        captureToolCallArguments(event, toolCallArgumentsById);
        for (const e of maybeEmitCommandMessagesFromItems([event])) {
          yield e;
        }
      }
    }

    const completedResult = await stream.completed;
    const rawResponses = Array.isArray(stream?.rawResponses) ? stream.rawResponses : [];
    let usageFromRawResponses: NormalizedUsage | undefined;
    for (let i = rawResponses.length - 1; i >= 0; i--) {
      const candidate = extractUsage(rawResponses[i]);
      if (candidate) {
        usageFromRawResponses = candidate;
        break;
      }
    }
    const finalUsage = extractUsage(completedResult) || extractUsage(stream) || usageFromRawResponses;
    if (finalUsage) {
      acc.latestUsage = finalUsage;
      const usageSource = extractUsage(completedResult)
        ? 'completed_result'
        : extractUsage(stream)
        ? 'stream_object'
        : 'stream_raw_responses';
      this.logger.debug('Usage extracted from stream completion', {
        sessionId: this.id,
        source: 'stream_completed',
        usageSource,
        usage: finalUsage,
      });
    } else {
      const completedResultRecord =
        completedResult && typeof completedResult === 'object' && !Array.isArray(completedResult)
          ? (completedResult as Record<string, unknown>)
          : undefined;

      const streamRecord =
        stream && typeof stream === 'object' && !Array.isArray(stream)
          ? (stream as Record<string, unknown>)
          : undefined;

      this.logger.debug('No usage found in stream completion', {
        sessionId: this.id,
        source: 'stream_completed',
        completedResultType:
          completedResult === null ? 'null' : Array.isArray(completedResult) ? 'array' : typeof completedResult,
        completedResultKeys: completedResultRecord ? Object.keys(completedResultRecord) : [],
        streamKeys: streamRecord ? Object.keys(streamRecord) : [],
        completedResultHasUsagePath: {
          usage: Boolean(completedResultRecord?.usage),
          usageMetadata: Boolean(completedResultRecord?.usageMetadata),
          usage_metadata: Boolean(completedResultRecord?.usage_metadata),
          responseUsage: Boolean((completedResultRecord?.response as any)?.usage),
        },
      });
    }

    this.flushStreamEventLog();
  }

  #buildResult(
    result: any,
    finalOutputOverride?: string,
    reasoningOutputOverride?: string,
    emittedCommandIds?: Set<string>,
    usage?: NormalizedUsage,
  ): ConversationResult {
    if (result.interruptions && result.interruptions.length > 0) {
      const interruption = result.interruptions[0];
      this.approvalState.setPending({
        state: result.state,
        interruption,
        emittedCommandIds: emittedCommandIds ?? new Set(),
        toolCallArgumentsById: new Map(this.toolCallArgumentsById),
      });

      let argumentsText = '';
      const toolName = interruption.name;

      // For shell_call (built-in shell tool), extract commands from action
      // For function tools (bash, shell), extract from arguments
      if (interruption.type === 'shell_call') {
        if (interruption.action?.commands) {
          argumentsText = Array.isArray(interruption.action.commands)
            ? interruption.action.commands.join('\n')
            : String(interruption.action.commands);
        }
      } else {
        argumentsText = getCommandFromArgs(interruption.arguments);
      }

      const callId =
        interruption?.rawItem?.callId ??
        interruption?.callId ??
        interruption?.call_id ??
        interruption?.tool_call_id ??
        interruption?.toolCallId ??
        interruption?.id;

      return {
        type: 'approval_required',
        approval: {
          agentName: interruption.agent?.name ?? 'Agent',
          toolName: toolName ?? 'Unknown Tool',
          argumentsText,
          rawInterruption: interruption,
          ...(callId ? { callId: String(callId) } : {}),
        },
      };
    }

    this.approvalState.clearPending();

    const allCommandMessages = extractCommandMessages(result.newItems || result.history || []);

    // Filter out commands that were already emitted in real-time
    const commandMessages = emittedCommandIds
      ? allCommandMessages.filter((msg) => !emittedCommandIds.has(msg.id))
      : allCommandMessages;

    const visibleCommandMessages = commandMessages.filter((msg) => !msg.isApprovalRejection);

    const response = {
      type: 'response' as const,
      commandMessages: visibleCommandMessages,
      finalText: finalOutputOverride ?? result.finalOutput ?? 'Done.',
      reasoningText: reasoningOutputOverride,
      usage: usage ?? extractUsage(result),
    };

    return response;
  }
}
