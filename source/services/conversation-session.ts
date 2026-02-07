import type {OpenAIAgentClient} from '../lib/openai-agent-client.js';
import {
    extractCommandMessages,
    markToolCallAsApprovalRejection,
} from '../utils/extract-command-messages.js';
import type {ILoggingService} from './service-interfaces.js';
import {ConversationStore} from './conversation-store.js';
import {ModelBehaviorError} from '@openai/agents';
import type {ConversationEvent} from './conversation-events.js';
import {extractUsage, type NormalizedUsage} from '../utils/token-usage.js';

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

export interface CommandMessage {
    id: string;
    sender: 'command';
    status: 'pending' | 'running' | 'completed' | 'failed';
    command: string;
    output: string;
    success?: boolean;
    failureReason?: string;
    isApprovalRejection?: boolean;
    callId?: string;
    toolName?: string;
    toolArgs?: any;
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
        const cmdFromObject =
            'command' in args ? String(args.command) : undefined;
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

export class ConversationSession {
    public readonly id: string;
    private agentClient: OpenAIAgentClient;
    private logger: ILoggingService;
    private conversationStore: ConversationStore;
    private previousResponseId: string | null = null;
    private pendingApprovalContext: {
        state: any;
        interruption: any;
        emittedCommandIds: Set<string>;
        toolCallArgumentsById: Map<string, unknown>;
        removeInterceptor?: () => void;
    } | null = null;
    private abortedApprovalContext: {
        state: any;
        interruption: any;
        emittedCommandIds: Set<string>;
        toolCallArgumentsById: Map<string, unknown>;
    } | null = null;
    private textDeltaCount = 0;
    private reasoningDeltaCount = 0;
    private toolCallArgumentsById = new Map<string, unknown>();
    private lastEventType: string | null = null;
    private eventTypeCount = 0;
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
        {
            agentClient,
            deps,
        }: {agentClient: OpenAIAgentClient; deps: {logger: ILoggingService}},
    ) {
        this.id = id;
        this.agentClient = agentClient;
        this.logger = deps.logger;
        this.conversationStore = new ConversationStore();
    }

    reset(): void {
        this.previousResponseId = null;
        this.conversationStore.clear();
        this.pendingApprovalContext = null;
        this.abortedApprovalContext = null;
        this.toolCallArgumentsById.clear();
        if (
            typeof (this.agentClient as any).clearConversations === 'function'
        ) {
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
        if (this.pendingApprovalContext) {
            this.abortedApprovalContext = this.pendingApprovalContext;
            this.pendingApprovalContext = null;
            this.logger.debug(
                'Aborted approval - will handle rejection on next message',
            );
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
            const shouldAddUserMessage =
                !skipUserMessage && !this.abortedApprovalContext;

            // Maintain canonical local history regardless of provider.
            if (shouldAddUserMessage) {
                this.conversationStore.addUserMessage(text);
            }

            // If there's an aborted approval, we need to resolve it first.
            // The user's message is a new input, but the agent is stuck waiting for tool output.
            if (this.abortedApprovalContext) {
                this.logger.debug(
                    'Resolving aborted approval with fake execution',
                    {
                        message: text,
                    },
                );

                const {
                    state,
                    interruption,
                    emittedCommandIds,
                    toolCallArgumentsById,
                } = this.abortedApprovalContext;
                this.abortedApprovalContext = null;

                // Restore cached tool-call arguments captured before abort so continuation can attach them
                this.toolCallArgumentsById.clear();
                if (toolCallArgumentsById?.size) {
                    for (const [
                        key,
                        value,
                    ] of toolCallArgumentsById.entries()) {
                        this.toolCallArgumentsById.set(key, value);
                    }
                }

                // Add interceptor for this tool execution
                const toolName = interruption.name ?? 'unknown';
                const expectedCallId =
                    (interruption as any).rawItem?.callId ??
                    (interruption as any).callId;
                const rejectionMessage = `Tool execution was not approved. User provided new input instead: ${text}`;

                const removeInterceptor = this.agentClient.addToolInterceptor(
                    async (name: string, _params: any, toolCallId?: string) => {
                        // Match both tool name and call ID for stricter matching
                        if (
                            name === toolName &&
                            (!expectedCallId || toolCallId === expectedCallId)
                        ) {
                            markToolCallAsApprovalRejection(
                                toolCallId ?? expectedCallId,
                            );
                            return rejectionMessage;
                        }
                        return null;
                    },
                );

                state.approve(interruption);

                try {
                    const stream = await this.agentClient.continueRunStream(
                        state,
                        {
                            previousResponseId: this.previousResponseId,
                        },
                    );

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
                    if (
                        stream.interruptions &&
                        stream.interruptions.length > 0
                    ) {
                        this.logger.warn(
                            'Another interruption occurred after fake execution - handling as approval',
                        );
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
                            const interruption =
                                result.approval.rawInterruption;
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
                                    argumentsText:
                                        result.approval.argumentsText,
                                    ...(callId ? {callId: String(callId)} : {}),
                                },
                            };
                        } else {
                            yield {
                                type: 'final',
                                finalText: result.finalText,
                                ...(result.reasoningText
                                    ? {reasoningText: result.reasoningText}
                                    : {}),
                                ...(result.commandMessages?.length
                                    ? {commandMessages: result.commandMessages}
                                    : {}),
                                ...(result.usage ? {usage: result.usage} : {}),
                            };
                        }
                        return;
                    }

                    // Successfully resolved - agent should now have processed the fake rejection
                    this.logger.debug(
                        'Fake execution completed, agent received rejection message',
                    );

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
                                ...(callId ? {callId: String(callId)} : {}),
                            },
                        };
                    } else {
                        yield {
                            type: 'final',
                            finalText: result.finalText,
                            ...(result.reasoningText
                                ? {reasoningText: result.reasoningText}
                                : {}),
                            ...(result.commandMessages?.length
                                ? {commandMessages: result.commandMessages}
                                : {}),
                            ...(result.usage ? {usage: result.usage} : {}),
                        };
                    }
                    return;
                } catch (error) {
                    this.logger.warn(
                        'Error resolving aborted approval with fake execution',
                        {
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        },
                    );
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

            // Only OpenAI uses server-side conversation management via previousResponseId.
            // All other providers (OpenRouter, openai-compatible) need full history.

            stream = await this.agentClient.startStream(
                provider !== 'openai'
                    ? (this.conversationStore.getHistory() as any)
                    : text,
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
                        ...(callId ? {callId: String(callId)} : {}),
                    },
                };
                return;
            }

            yield {
                type: 'final',
                finalText: result.finalText,
                ...(result.reasoningText
                    ? {reasoningText: result.reasoningText}
                    : {}),
                ...(result.commandMessages?.length
                    ? {commandMessages: result.commandMessages}
                    : {}),
                ...(result.usage ? {usage: result.usage} : {}),
            };
        } catch (error) {
            // Handle tool hallucination: model called a non-existent tool
            if (
                isToolHallucinationError(error) &&
                hallucinationRetryCount < MAX_HALLUCINATION_RETRIES
            ) {
                const toolName =
                    error instanceof Error
                        ? error.message.match(/Tool (\S+) not found/)?.[1] ||
                          'unknown'
                        : 'unknown';

                this.logger.warn('Tool hallucination detected, retrying', {
                    toolName,
                    attempt: hallucinationRetryCount + 1,
                    maxRetries: MAX_HALLUCINATION_RETRIES,
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                });

                yield {
                    type: 'retry',
                    toolName,
                    attempt: hallucinationRetryCount + 1,
                    maxRetries: MAX_HALLUCINATION_RETRIES,
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
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
        if (!this.pendingApprovalContext) {
            return;
        }

        const {
            state,
            interruption,
            emittedCommandIds: previouslyEmittedIds,
            toolCallArgumentsById,
        } = this.pendingApprovalContext;

        let removeInterceptor: (() => void) | null = null;

        if (answer === 'y') {
            state.approve(interruption);
        } else {
            const toolName = interruption.name ?? 'unknown';
            const expectedCallId =
                (interruption as any).rawItem?.callId ??
                (interruption as any).callId;
            const rejectionMessage = rejectionReason
                ? `Tool execution was not approved. User's reason: ${rejectionReason}`
                : 'Tool execution was not approved.';

            if (typeof this.agentClient.addToolInterceptor === 'function') {
                const removeInterceptor = this.agentClient.addToolInterceptor(
                    async (name: string, _params: any, toolCallId?: string) => {
                        if (
                            name === toolName &&
                            (!expectedCallId || toolCallId === expectedCallId)
                        ) {
                            markToolCallAsApprovalRejection(
                                toolCallId ?? expectedCallId,
                            );
                            return rejectionMessage;
                        }
                        return null;
                    },
                );

                // Approve to continue but interceptor will return rejection message
                state.approve(interruption);

                // Store interceptor cleanup for after stream
                this.pendingApprovalContext = {
                    ...this.pendingApprovalContext,
                    removeInterceptor,
                };
            } else {
                // Fallback for clients without tool interceptors
                state.reject(interruption);
            }
        }

        removeInterceptor =
            this.pendingApprovalContext?.removeInterceptor ?? null;

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
            const allEmittedIds = new Set([
                ...previouslyEmittedIds,
                ...acc.emittedCommandIds,
            ]);

            const result = this.#buildResult(
                stream,
                acc.finalOutput || undefined,
                acc.reasoningOutput || undefined,
                allEmittedIds,
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
                        ...(callId ? {callId: String(callId)} : {}),
                    },
                };
                return;
            }

            yield {
                type: 'final',
                finalText: result.finalText,
                ...(result.reasoningText
                    ? {reasoningText: result.reasoningText}
                    : {}),
                ...(result.commandMessages?.length
                    ? {commandMessages: result.commandMessages}
                    : {}),
                ...(result.usage ? {usage: result.usage} : {}),
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

        for await (const event of this.run(text, {hallucinationRetryCount})) {
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
                    const rawInterruption =
                        this.pendingApprovalContext?.interruption;
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

        return {
            type: 'response',
            commandMessages,
            finalText: finalText || 'Done.',
            ...(reasoningText ? {reasoningText} : {}),
            ...(usage ? {usage} : {}),
        };
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
        if (!this.pendingApprovalContext) {
            return null;
        }

        let finalText = '';
        let reasoningText = '';
        const commandMessages: CommandMessage[] = [];
        let usage: NormalizedUsage | undefined;
        let sawTerminalEvent: ConversationEvent | null = null;

        for await (const event of this['continue']({answer, rejectionReason})) {
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
                    const rawInterruption =
                        this.pendingApprovalContext?.interruption;
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
            return {
                type: 'response',
                commandMessages,
                finalText: finalText || 'Done.',
                ...(reasoningText ? {reasoningText} : {}),
                ...(usage ? {usage} : {}),
            };
        }

        return {
            type: 'response',
            commandMessages,
            finalText: finalText || 'Done.',
            ...(reasoningText ? {reasoningText} : {}),
            ...(usage ? {usage} : {}),
        };
    }

    async *#streamEvents(
        stream: any,
        acc: {
            finalOutput: string;
            reasoningOutput: string;
            emittedCommandIds: Set<string>;
            latestUsage?: NormalizedUsage;
        },
        {preserveExistingToolArgs}: {preserveExistingToolArgs: boolean},
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
            }

            // Log event type with deduplication for ordering understanding

            const delta1 = this.#extractTextDelta(event);
            if (delta1) {
                const e = emitText(delta1);
                if (e) yield e;
            }
            if (event?.data) {
                const delta2 = this.#extractTextDelta(event.data);
                if (delta2) {
                    const e = emitText(delta2);
                    if (e) yield e;
                }
            }

            // Handle reasoning items
            const reasoningDelta = (() => {
                // OpenAI style
                const data = event?.data;
                if (
                    data &&
                    typeof data === 'object' &&
                    (data as any).type === 'model'
                ) {
                    const eventDetail = (data as any).event;
                    if (
                        eventDetail &&
                        typeof eventDetail === 'object' &&
                        eventDetail.type ===
                            'response.reasoning_summary_text.delta'
                    ) {
                        return eventDetail.delta ?? '';
                    }
                }

                // OpenRouter style
                const choices = event?.data?.event?.choices;
                if (!choices) return '';
                if (Array.isArray(choices)) {
                    return choices[0]?.delta?.reasoning ?? choices[0]?.delta?.reasoning_content ?? '';
                }
                if (typeof choices === 'object') {
                    const byZero = (choices as Record<string, any>)['0'];
                    const first = byZero ?? choices[Object.keys(choices)[0]];
                    return first?.delta?.reasoning ?? first?.delta?.reasoning_content ?? '';
                }
                return '';
            })();
            if (reasoningDelta) {
                const e = emitReasoning(reasoningDelta);
                if (e) yield e;
            }

            const maybeEmitCommandMessagesFromItems = (items: any[]) => {
                this.#attachCachedArguments(items, toolCallArgumentsById);
                const commandMessages = extractCommandMessages(items);
                const out: ConversationEvent[] = [];

                for (const cmdMsg of commandMessages) {
                    if (acc.emittedCommandIds.has(cmdMsg.id)) {
                        continue;
                    }
                    if (cmdMsg.isApprovalRejection) {
                        continue;
                    }
                    acc.emittedCommandIds.add(cmdMsg.id);
                    out.push({type: 'command_message', message: cmdMsg});
                }
                return out;
            };

            if (event?.type === 'run_item_stream_event') {
                this.#captureToolCallArguments(
                    event.item,
                    toolCallArgumentsById,
                );

                // Emit tool_started event when a function_call is detected
                const rawItem = event.item?.rawItem ?? event.item;
                if (rawItem?.type === 'function_call') {
                    const callId =
                        rawItem.callId ??
                        rawItem.call_id ??
                        rawItem.tool_call_id ??
                        rawItem.toolCallId ??
                        rawItem.id;
                    if (callId) {
                        const toolName = rawItem.name ?? event.item?.name;
                        const args =
                            rawItem.arguments ??
                            rawItem.args ??
                            event.item?.arguments ??
                            event.item?.args;

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
                                return args;
                            }
                        })();
                        yield {
                            type: 'tool_started' as const,
                            toolCallId: callId,
                            toolName: toolName ?? 'unknown',
                            arguments: normalizedArgs,
                        };
                    }
                }

                for (const e of maybeEmitCommandMessagesFromItems([
                    event.item,
                ])) {
                    yield e;
                }
            } else if (
                event?.type === 'tool_call_output_item' ||
                event?.rawItem?.type === 'function_call_output'
            ) {
                this.#captureToolCallArguments(event, toolCallArgumentsById);
                for (const e of maybeEmitCommandMessagesFromItems([event])) {
                    yield e;
                }
            }
        }

        const completedResult = await stream.completed;
        const finalUsage = extractUsage(completedResult) || extractUsage(stream);
        if (finalUsage) {
            acc.latestUsage = finalUsage;
        }

        this.flushStreamEventLog();
    }

    #captureToolCallArguments(
        item: any,
        toolCallArgumentsById: Map<string, unknown>,
    ): void {
        const rawItem = item?.rawItem ?? item;
        if (!rawItem) {
            return;
        }

        if (rawItem?.type !== 'function_call') {
            return;
        }

        const callId =
            rawItem.callId ??
            rawItem.call_id ??
            rawItem.tool_call_id ??
            rawItem.toolCallId ??
            rawItem.id;
        if (!callId) {
            return;
        }

        const args =
            rawItem.arguments ?? rawItem.args ?? item?.arguments ?? item?.args;
        if (!args) {
            return;
        }

        toolCallArgumentsById.set(callId, args);
    }

    #attachCachedArguments(
        items: any[] = [],
        toolCallArgumentsById: Map<string, unknown>,
    ): void {
        if (!items?.length) {
            return;
        }

        for (const item of items) {
            if (!item) {
                continue;
            }

            if (
                item.arguments ||
                item.args ||
                item?.rawItem?.arguments ||
                item?.rawItem?.args
            ) {
                continue;
            }

            const rawItem = item?.rawItem ?? item;
            const callId =
                rawItem?.callId ??
                rawItem?.call_id ??
                rawItem?.tool_call_id ??
                rawItem?.toolCallId ??
                rawItem?.id ??
                item?.callId ??
                item?.call_id ??
                item?.tool_call_id ??
                item?.toolCallId ??
                item?.id;
            if (!callId) {
                continue;
            }

            const args = toolCallArgumentsById.get(callId);
            if (!args) {
                continue;
            }

            item.arguments = args;
        }
    }

    #extractTextDelta(payload: any): string | null {
        if (payload === null || payload === undefined) {
            return null;
        }

        if (typeof payload === 'string') {
            return payload || null;
        }

        if (typeof payload !== 'object') {
            return null;
        }

        const type =
            typeof (payload as any).type === 'string' ? payload.type : '';
        const looksLikeOutput =
            typeof type === 'string' && type.includes('output_text');
        const hasOutputProperties = Boolean(
            (payload as any).delta ??
                (payload as any).output_text ??
                (payload as any).text ??
                (payload as any).content,
        );

        if (!looksLikeOutput && !hasOutputProperties) {
            return null;
        }

        const deltaCandidate =
            (payload as any).delta ??
            (payload as any).output_text ??
            (payload as any).text ??
            (payload as any).content;
        const text = this.#coerceToText(deltaCandidate);
        return text || null;
    }

    #coerceToText(value: unknown): string {
        if (value === null || value === undefined) {
            return '';
        }

        if (typeof value === 'string') {
            return value;
        }

        if (typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }

        if (Array.isArray(value)) {
            return value
                .map(entry => this.#coerceToText(entry))
                .filter(Boolean)
                .join('');
        }

        if (typeof value === 'object') {
            const record = value as Record<string, unknown>;
            const candidates = ['text', 'value', 'content', 'delta'];
            for (const field of candidates) {
                if (field in record) {
                    const text = this.#coerceToText(record[field]);
                    if (text) {
                        return text;
                    }
                }
            }
        }

        return '';
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
            this.pendingApprovalContext = {
                state: result.state,
                interruption,
                emittedCommandIds: emittedCommandIds ?? new Set(),
                toolCallArgumentsById: new Map(this.toolCallArgumentsById),
            };

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
                    ...(callId ? {callId: String(callId)} : {}),
                },
            };
        }

        this.pendingApprovalContext = null;

        const allCommandMessages = extractCommandMessages(
            result.newItems || result.history || [],
        );

        // Filter out commands that were already emitted in real-time
        const commandMessages = emittedCommandIds
            ? allCommandMessages.filter(msg => !emittedCommandIds.has(msg.id))
            : allCommandMessages;

        const visibleCommandMessages = commandMessages.filter(
            msg => !msg.isApprovalRejection,
        );

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
