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
    private textDeltaCount = 0;
    private reasoningDeltaCount = 0;
    private debugLog = (stage: string, data: any) => {
        loggingService.debug(`[REASONING] ${stage}`, data);
    };

    constructor({agentClient}: {agentClient: OpenAIAgentClient}) {
        this.agentClient = agentClient;
    }

    reset(): void {
        this.previousResponseId = null;
        this.pendingApprovalContext = null;
    }

    setModel(model: string): void {
        this.agentClient.setModel(model);
    }

    setReasoningEffort(effort: any): void {
        if (typeof this.agentClient.setReasoningEffort === 'function') {
            this.agentClient.setReasoningEffort(effort);
        }
    }

    /**
     * Abort the current running operation
     */
    abort(): void {
        this.agentClient.abort();
        this.pendingApprovalContext = null;
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
        this.debugLog('sendMessage_start', {
            hasOnTextChunk: !!onTextChunk,
            hasOnReasoningChunk: !!onReasoningChunk,
            hasOnCommandMessage: !!onCommandMessage,
        });

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
        this.debugLog('sendMessage_streamConsumed', {
            finalOutputLength: finalOutput.length,
            reasoningOutputLength: reasoningOutput.length,
            emittedCommandCount: emittedCommandIds.size,
        });
        // Pass emittedCommandIds so we don't duplicate commands in the final result
        return this.#buildResult(
            stream,
            finalOutput || undefined,
            reasoningOutput || undefined,
            emittedCommandIds,
        );
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
        this.debugLog('handleApprovalDecision_start', {
            hasPendingContext: !!this.pendingApprovalContext,
            answer,
            hasOnReasoningChunk: !!onReasoningChunk,
        });

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

        const stream = await this.agentClient.continueRunStream(state);

        const {finalOutput, reasoningOutput, emittedCommandIds} =
            await this.#consumeStream(stream, {
                onTextChunk,
                onReasoningChunk,
                onCommandMessage,
            });

        this.previousResponseId = stream.lastResponseId;
        this.debugLog('handleApprovalDecision_streamConsumed', {
            finalOutputLength: finalOutput.length,
            reasoningOutputLength: reasoningOutput.length,
            previouslyEmittedCount: previouslyEmittedIds.size,
            newlyEmittedCount: emittedCommandIds.size,
        });

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

        this.debugLog('consumeStream_start', {
            hasOnTextChunk: !!onTextChunk,
            hasOnReasoningChunk: !!onReasoningChunk,
            hasOnCommandMessage: !!onCommandMessage,
        });

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
            // Log event type for ordering understanding
            this.debugLog('stream_event_received', {
                eventType: event?.type,
                eventName: event?.name,
                hasData: !!event?.data,
            });

            this.#emitTextDelta(event, emitText);
            if (event?.data) {
                this.#emitTextDelta(event.data, emitText);
            }

            // Handle reasoning items - look for reasoning_item_created event
            if (
                event?.type === 'run_item_stream_event' &&
                event?.name === 'reasoning_item_created' &&
                event.item?.type === 'reasoning_item'
            ) {
                const reasoningItem = event.item;
                this.debugLog('reasoning_item_detected', {
                    hasRawItem: !!reasoningItem.rawItem,
                    hasContent: !!reasoningItem.rawItem?.content,
                    isArray: Array.isArray(reasoningItem.rawItem?.content),
                    contentLength: reasoningItem.rawItem?.content?.length,
                });

                // Extract and emit reasoning text from content array
                if (
                    reasoningItem.rawItem?.content &&
                    Array.isArray(reasoningItem.rawItem.content)
                ) {
                    for (const contentItem of reasoningItem.rawItem.content) {
                        if (contentItem.text) {
                            this.debugLog('reasoning_text_extracted', {
                                textLength: contentItem.text.length,
                                preview: contentItem.text.substring(0, 100),
                            });
                            emitReasoning(contentItem.text);
                        }
                    }
                }
            }

            if (event?.type === 'run_item_stream_event') {
                this.debugLog('command_message_event', {
                    eventName: event?.name,
                    itemType: event?.item?.type,
                });

                this.#emitCommandMessages(
                    [event.item],
                    emittedCommandIds,
                    onCommandMessage,
                );
            } else if (
                event?.type === 'tool_call_output_item' ||
                event?.rawItem?.type === 'function_call_output'
            ) {
                this.debugLog('tool_output_event', {
                    eventType: event?.type,
                    rawItemType: event?.rawItem?.type,
                });

                this.#emitCommandMessages(
                    [event],
                    emittedCommandIds,
                    onCommandMessage,
                );
            }
        }

        await stream.completed;
        this.debugLog('consumeStream_complete', {
            finalOutputLength: finalOutput.length,
            reasoningOutputLength: reasoningOutput.length,
            textDeltaCount: this.textDeltaCount,
            reasoningDeltaCount: this.reasoningDeltaCount,
            emittedCommandCount: emittedCommandIds.size,
        });
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

        if (commandMessages.length > 0) {
            this.debugLog('emitCommandMessages', {
                totalExtracted: commandMessages.length,
                emitted: emittedCount,
                skipped: skippedCount,
            });
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
        this.debugLog('buildResult_start', {
            hasInterruptions: !!result.interruptions?.length,
            finalOutputOverrideLength: finalOutputOverride?.length,
            reasoningOutputOverrideLength: reasoningOutputOverride?.length,
        });

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

            this.debugLog('buildResult_approval_required', {
                toolName,
                argumentsTextLength: argumentsText.length,
            });

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

        this.debugLog('buildResult_response', {
            hasReasoningText: !!response.reasoningText,
            reasoningTextLength: response.reasoningText?.length,
            finalTextLength: response.finalText.length,
            totalCommandsExtracted: allCommandMessages.length,
            commandMessagesAfterFilter: commandMessages.length,
            emittedCommandIdsCount: emittedCommandIds?.size,
        });

        return response;
    }
}
