import type {OpenAIAgentClient} from '../lib/openai-agent-client.js';
import {extractCommandMessages} from '../utils/extract-command-messages.js';
import {loggingService} from './logging-service.js';

interface ApprovalResult {
    type: 'approval_required';
    approval: {
        agentName: string;
        toolName: string;
        argumentsText: string;
        rawInterruption: any;
    };
}

export interface CommandMessage {
    id: string;
    sender: 'command';
    command: string;
    output: string;
    success?: boolean;
}

interface ResponseResult {
    type: 'response';
    commandMessages: CommandMessage[];
    finalText: string;
    reasoningText?: string;
}

export type ConversationResult = ApprovalResult | ResponseResult;

const getCommandFromArgs = (args: unknown): string => {
    if (!args) {
        return '';
    }

    if (typeof args === 'string') {
        try {
            const parsed = JSON.parse(args);
            // Handle shell tool's commands array
            if (Array.isArray(parsed?.commands)) {
                return parsed.commands.join('\n');
            }
            return parsed?.command ?? args;
        } catch {
            return args;
        }
    }

    if (typeof args === 'object') {
        // Handle shell tool's commands array
        if ('commands' in args && Array.isArray(args.commands)) {
            return (args.commands as string[]).join('\n');
        }
        const cmdFromObject =
            'command' in args ? String(args.command) : undefined;
        const argsFromObject =
            'arguments' in args ? String(args.arguments) : undefined;
        return cmdFromObject ?? argsFromObject ?? JSON.stringify(args);
    }

    return String(args);
};

export class ConversationService {
    private agentClient: OpenAIAgentClient;
    private previousResponseId: string | null = null;
    private pendingApprovalContext: {
        state: any;
        interruption: any;
        emittedCommandIds: Set<string>;
    } | null = null;
    private abortedApprovalContext: {
        state: any;
        interruption: any;
        emittedCommandIds: Set<string>;
    } | null = null;
    private textDeltaCount = 0;
    private reasoningDeltaCount = 0;
    private lastEventType: string | null = null;
    private eventTypeCount = 0;
    private logStreamEvent = (eventType: string, eventData: any) => {
		if (eventData.item) {
			eventType = eventData.item.type;
			eventData = eventData.item.rawItem;
			this.logStreamEvent(eventType, eventData);
		}

		// Deduplicate consecutive identical event types
        if (eventType !== this.lastEventType) {
            if (this.lastEventType !== null && this.eventTypeCount > 0) {
                loggingService.debug('Stream event summary', {
                    eventType: this.lastEventType,
                    count: this.eventTypeCount,
                });
            }
            this.lastEventType = eventType;
            this.eventTypeCount = 1;
            // Log the first occurrence with details
            loggingService.debug('Stream event', {
                eventType,
                ...eventData,
            });
        } else {
            this.eventTypeCount++;
        }
    };
    private flushStreamEventLog = () => {
        if (this.lastEventType !== null && this.eventTypeCount > 1) {
            loggingService.debug('Stream event summary', {
                eventType: this.lastEventType,
                count: this.eventTypeCount,
            });
        }
        this.lastEventType = null;
        this.eventTypeCount = 0;
    };

    constructor({agentClient}: {agentClient: OpenAIAgentClient}) {
        this.agentClient = agentClient;
    }

    reset(): void {
        this.previousResponseId = null;
        this.pendingApprovalContext = null;
        this.abortedApprovalContext = null;
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

    setProvider(provider: string): void {
        if (typeof this.agentClient.setProvider === 'function') {
            (this.agentClient as any).setProvider(provider);
        }
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
            loggingService.debug('Aborted approval - will handle rejection on next message');
        }
    }

    async sendMessage(
        text: string,
        {
            onTextChunk,
            onReasoningChunk,
            onCommandMessage,
        }: {
            onTextChunk?: (fullText: string, chunk: string) => void;
            onReasoningChunk?: (fullText: string, chunk: string) => void;
            onCommandMessage?: (message: CommandMessage) => void;
        } = {},
    ): Promise<ConversationResult> {
        try {
            // If there's an aborted approval, we need to resolve it first
            // The user's message is a new input, but the agent is stuck waiting for tool output
            if (this.abortedApprovalContext) {
                loggingService.debug('Resolving aborted approval before processing new message', {
                    message: text,
                });

                let currentContext: {
                    state: any;
                    interruption: any;
                    emittedCommandIds: Set<string>;
                } | null = this.abortedApprovalContext;
                this.abortedApprovalContext = null;

                let attempts = 0;
                const maxAttempts = 3;

                while (currentContext && attempts < maxAttempts) {
                    const {state, interruption} = currentContext;
                    state.reject(interruption);

                    try {
                        const stream = await this.agentClient.continueRunStream(state, {
                            previousResponseId: this.previousResponseId,
                        });

                        // Consume the stream silently to update state
                        await this.#consumeStream(stream);
                        this.previousResponseId = stream.lastResponseId;

                        if (stream.interruptions && stream.interruptions.length > 0) {
                            // Another interruption occurred
                            const newInterruption = stream.interruptions[0];
                            currentContext = {
                                state: stream.state,
                                interruption: newInterruption,
                                emittedCommandIds: new Set(),
                            };
                            attempts++;
                            loggingService.debug('Aborted approval resolution resulted in another interruption', {
                                attempts,
                                tool: newInterruption.name
                            });
                        } else {
                            currentContext = null; // Resolved!
                        }
                    } catch (error) {
                        loggingService.warn('Error resolving aborted approval', {
                            error: error instanceof Error ? error.message : String(error)
                        });
                        // Break loop on error to avoid infinite loops or further errors
                        break;
                    }
                }

                if (currentContext) {
                    loggingService.warn('Could not fully resolve aborted approvals after max attempts. Proceeding anyway.');
                }
            }

            // Normal message flow
            const stream = await this.agentClient.startStream(text, {
                previousResponseId: this.previousResponseId,
            });

            const {finalOutput, reasoningOutput, emittedCommandIds} =
                await this.#consumeStream(stream, {
                    onTextChunk,
                    onReasoningChunk,
                    onCommandMessage,
                });
            this.previousResponseId = stream.lastResponseId;

            // Pass emittedCommandIds so we don't duplicate commands in the final result
            return this.#buildResult(
                stream,
                finalOutput || undefined,
                reasoningOutput || undefined,
                emittedCommandIds,
            );
        } catch (error) {
            throw error;
        }
    }

    async handleApprovalDecision(
        answer: string,
        {
            onTextChunk,
            onReasoningChunk,
            onCommandMessage,
        }: {
            onTextChunk?: (fullText: string, chunk: string) => void;
            onReasoningChunk?: (fullText: string, chunk: string) => void;
            onCommandMessage?: (message: CommandMessage) => void;
        } = {},
    ): Promise<ConversationResult | null> {
        if (!this.pendingApprovalContext) {
            return null;
        }

        const {
            state,
            interruption,
            emittedCommandIds: previouslyEmittedIds,
        } = this.pendingApprovalContext;
        if (answer === 'y') {
            state.approve(interruption);
        } else {
            state.reject(interruption);
        }

        try {
            const stream = await this.agentClient.continueRunStream(state, {
                previousResponseId: this.previousResponseId,
            });

            const {finalOutput, reasoningOutput, emittedCommandIds} =
                await this.#consumeStream(stream, {
                    onTextChunk,
                    onReasoningChunk,
                    onCommandMessage,
                });

            this.previousResponseId = stream.lastResponseId;

            // Merge previously emitted command IDs with newly emitted ones
            // This prevents duplicates when result.history contains commands from the initial stream
            const allEmittedIds = new Set([
                ...previouslyEmittedIds,
                ...emittedCommandIds,
            ]);

            return this.#buildResult(
                stream,
                finalOutput || undefined,
                reasoningOutput || undefined,
                allEmittedIds,
            );
        } catch (error) {
            throw error;
        }
    }

    async #consumeStream(
        stream: any,
        {
            onTextChunk,
            onReasoningChunk,
            onCommandMessage,
        }: {
            onTextChunk?: (fullText: string, chunk: string) => void;
            onReasoningChunk?: (fullText: string, chunk: string) => void;
            onCommandMessage?: (message: CommandMessage) => void;
        } = {},
    ): Promise<{
        finalOutput: string;
        reasoningOutput: string;
        emittedCommandIds: Set<string>;
    }> {
        let finalOutput = '';
        let reasoningOutput = '';
        const emittedCommandIds = new Set<string>();
        this.textDeltaCount = 0;
        this.reasoningDeltaCount = 0;

        const emitText = (delta: string) => {
            if (!delta) {
                return;
            }

            finalOutput += delta;
            this.textDeltaCount++;
            onTextChunk?.(finalOutput, delta);
        };

        const emitReasoning = (delta: string) => {
            if (!delta) {
                return;
            }

            reasoningOutput += delta;
            this.reasoningDeltaCount++;
            onReasoningChunk?.(reasoningOutput, delta);
        };

        for await (const event of stream) {
            // Log event type with deduplication for ordering understanding
            const eventType = event?.type || 'unknown';
            this.logStreamEvent(eventType, {
                eventName: event?.name,
                hasData: !!event?.data,
                item: event?.item,
            });

            this.#emitTextDelta(event, emitText);
            if (event?.data) {
                this.#emitTextDelta(event.data, emitText);
            }

            // Handle reasoning items - look for reasoning_item_created event
            const reasoningDelta = (() => {
                // OpenAI style
                const data = event?.data;
                if (data && typeof data === 'object' && (data as any).type === 'model') {
                    const eventDetail = (data as any).event;
                    if (
                        eventDetail && typeof eventDetail === 'object' &&
                        eventDetail.type === 'response.reasoning_summary_text.delta'
                    ) {
                        return eventDetail.delta ?? '';
                    }
                }

                // OpenRouter style
                const choices = event?.data?.event?.choices;
                if (!choices) return '';
                if (Array.isArray(choices)) {
                    return choices[0]?.delta?.reasoning ?? '';
                }
                if (typeof choices === 'object') {
                    const byZero = (choices as Record<string, any>)['0'];
                    const first = byZero ?? choices[Object.keys(choices)[0]];
                    return first?.delta?.reasoning ?? '';
                }
                return '';
            })();
            emitReasoning(reasoningDelta);

            if (event?.type === 'run_item_stream_event') {
                this.#emitCommandMessages(
                    [event.item],
                    emittedCommandIds,
                    onCommandMessage,
                );
            } else if (
                event?.type === 'tool_call_output_item' ||
                event?.rawItem?.type === 'function_call_output'
            ) {
                this.#emitCommandMessages(
                    [event],
                    emittedCommandIds,
                    onCommandMessage,
                );
            }
        }

        await stream.completed;
        this.flushStreamEventLog();
        return {finalOutput, reasoningOutput, emittedCommandIds};
    }

    #emitCommandMessages(
        items: any[] = [],
        emittedCommandIds: Set<string>,
        onCommandMessage?: (message: CommandMessage) => void,
    ): void {
        if (!items?.length || !onCommandMessage) {
            return;
        }

        const commandMessages = extractCommandMessages(items);
        let emittedCount = 0;
        let skippedCount = 0;

        for (const cmdMsg of commandMessages) {
            if (emittedCommandIds.has(cmdMsg.id)) {
                skippedCount++;
                continue;
            }

            emittedCommandIds.add(cmdMsg.id);
            onCommandMessage(cmdMsg);
            emittedCount++;
        }
    }

    #emitTextDelta(payload: any, emitText: (delta: string) => void): boolean {
        const deltaText = this.#extractTextDelta(payload);
        if (!deltaText) {
            return false;
        }

        emitText(deltaText);
        return true;
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
    ): ConversationResult {
        if (result.interruptions && result.interruptions.length > 0) {
            const interruption = result.interruptions[0];
            this.pendingApprovalContext = {
                state: result.state,
                interruption,
                emittedCommandIds: emittedCommandIds ?? new Set(),
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

            return {
                type: 'approval_required',
                approval: {
                    agentName: interruption.agent?.name ?? 'Agent',
                    toolName: toolName ?? 'Unknown Tool',
                    argumentsText,
                    rawInterruption: interruption,
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

        const response = {
            type: 'response' as const,
            commandMessages,
            finalText: finalOutputOverride ?? result.finalOutput ?? 'Done.',
            reasoningText: reasoningOutputOverride,
        };

        return response;
    }
}
