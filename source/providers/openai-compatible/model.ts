import {
    type Model,
    type ModelRequest,
    type ModelResponse,
    type ResponseStreamEvent,
} from '@openai/agents-core';
import {randomUUID} from 'node:crypto';
import type {
    ILoggingService,
    ISettingsService,
} from '../../services/service-interfaces.js';
import {callOpenAICompatibleChatCompletions} from './api.js';
import {
    buildMessagesFromRequest,
    extractFunctionToolsFromRequest,
} from '../openrouter/converters.js';
import {normalizeUsage, decodeHtmlEntities} from '../openrouter/utils.js';

export class OpenAICompatibleModel implements Model {
    name: string;

    #providerId: string;
    #modelId: string;
    #baseUrl: string;
    #apiKey?: string;
    #settingsService: ISettingsService;
    #loggingService: ILoggingService;

    constructor(deps: {
        settingsService: ISettingsService;
        loggingService: ILoggingService;
        providerId: string;
        baseUrl: string;
        apiKey?: string;
        modelId?: string;
    }) {
        this.#providerId = deps.providerId;
        this.name = deps.providerId;
        this.#settingsService = deps.settingsService;
        this.#loggingService = deps.loggingService;
        this.#baseUrl = deps.baseUrl;
        this.#apiKey = deps.apiKey;
        this.#modelId =
            deps.modelId ||
            this.#settingsService.get('agent.model') ||
            'gpt-4o-mini';
    }

    async getResponse(request: ModelRequest): Promise<ModelResponse> {
        const resolvedModelId =
            this.#resolveModelFromRequest(request) || this.#modelId;
        const messages = buildMessagesFromRequest(
            request,
            resolvedModelId,
            this.#loggingService,
        );

        const tools = extractFunctionToolsFromRequest(request);

        const res = await callOpenAICompatibleChatCompletions({
            baseUrl: this.#baseUrl,
            apiKey: this.#apiKey,
            model: resolvedModelId,
            messages,
            stream: false,
            signal: request.signal,
            settings: request.modelSettings,
            tools,
        });

        const json: any = await res.json();
        const choice = json?.choices?.[0];
        const contentFromChoice = choice?.message?.content ?? '';
        const textContent =
            typeof contentFromChoice === 'string'
                ? contentFromChoice
                : JSON.stringify(contentFromChoice);

        const responseId = json?.id ?? randomUUID();
        const usage = normalizeUsage(json?.usage || {}) as any;

        const reasoning = choice?.message?.reasoning || choice?.message?.reasoning_content;
        const reasoningDetails = choice?.message?.reasoning_details;
        const toolCalls = choice?.message?.tool_calls;

        // Log raw tool calls from API response
        if (toolCalls && toolCalls.length > 0) {
            this.#loggingService.debug('OpenAI-compatible raw tool calls (non-streaming)', {
                provider: this.#providerId,
                toolCallsCount: toolCalls.length,
                toolCalls: JSON.stringify(toolCalls),
            });
        }

        const output: any[] = [];

        // Preserve reasoning blocks when present (OpenRouter-compatible shape).
        if (reasoningDetails && Array.isArray(reasoningDetails)) {
            for (const reasoningItem of reasoningDetails) {
                const outputItem: any = {
                    type: 'reasoning',
                    id:
                        reasoningItem.id ||
                        `reasoning-${Date.now()}-${reasoningItem.index || 0}`,
                    content: [],
                    providerData: reasoningItem,
                };

                if (
                    reasoningItem.type === 'reasoning.text' &&
                    reasoningItem.text
                ) {
                    outputItem.content.push({
                        type: 'input_text',
                        text: reasoningItem.text,
                        providerData: {
                            format: reasoningItem.format,
                            index: reasoningItem.index,
                        },
                    });
                } else if (
                    reasoningItem.type === 'reasoning.summary' &&
                    reasoningItem.summary
                ) {
                    outputItem.content.push({
                        type: 'input_text',
                        text: reasoningItem.summary,
                        providerData: {
                            format: reasoningItem.format,
                            index: reasoningItem.index,
                        },
                    });
                } else if (reasoningItem.type === 'reasoning.encrypted') {
                    outputItem.content = [];
                }

                output.push(outputItem);
            }
        }

        if (textContent) {
            output.push({
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                    {
                        type: 'output_text',
                        text: textContent,
                    },
                ],
                ...(typeof reasoning === 'string' ? {reasoning} : {}),
                ...(reasoningDetails != null
                    ? {reasoning_details: reasoningDetails}
                    : {}),
            } as any);
        }

        // Non-streaming tool calls: OpenAI-style nested function object.
        if (toolCalls && toolCalls.length > 0) {
            for (const toolCall of toolCalls) {
                if (toolCall.type === 'function') {
                    const decodedArgs = decodeHtmlEntities(
                        toolCall.function.arguments,
                    );
                    output.push({
                        type: 'function_call',
                        callId: toolCall.id,
                        name: toolCall.function.name,
                        arguments: decodedArgs,
                        status: 'completed',
                        ...(typeof reasoning === 'string' ? {reasoning} : {}),
                        ...(reasoningDetails != null
                            ? {reasoning_details: reasoningDetails}
                            : {}),
                    } as any);
                }
            }
        }

        return {
            usage,
            output,
            responseId,
            providerData: json,
        };
    }

    async *getStreamedResponse(
        request: ModelRequest,
    ): AsyncIterable<ResponseStreamEvent> {
        const resolvedModelId =
            this.#resolveModelFromRequest(request) || this.#modelId;
        const messages = buildMessagesFromRequest(
            request,
            resolvedModelId,
            this.#loggingService,
        );
        const tools = extractFunctionToolsFromRequest(request);

        this.#loggingService.debug('OpenAI-compatible stream start', {
            provider: this.#providerId,
            messageCount: Array.isArray(messages) ? messages.length : 0,
            messageRoles: Array.isArray(messages)
                ? messages.map((m: any) => m.role)
                : [],
            toolsCount: Array.isArray(tools) ? tools.length : 0,
        });

        const res = await callOpenAICompatibleChatCompletions({
            baseUrl: this.#baseUrl,
            apiKey: this.#apiKey,
            model: resolvedModelId,
            messages,
            stream: true,
            signal: request.signal,
            settings: request.modelSettings,
            tools,
        });

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';
        let responseId = 'unknown';
        let usageData: any = null;
        let accumulatedReasoningText = '';
        const accumulatedReasoning: any[] = [];
        const accumulatedToolCalls: any[] = [];

        if (!reader) {
            const full = await this.getResponse(request);
            yield {
                type: 'response_done',
                response: {
                    id: full.responseId || 'unknown',
                    usage: normalizeUsage(full.usage),
                    output: full.output,
                },
            } as any;
            return;
        }

        const state = {
            accumulated,
            responseId,
            usageData,
            accumulatedReasoningText,
            accumulatedReasoning,
            accumulatedToolCalls,
        };

        while (true) {
            const {done, value} = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, {stream: true});

            for (const line of this.#splitBufferIntoLines(buffer)) {
                buffer = line.remainingBuffer;
                if (!line.content) continue;

                const events = this.#processSSELine(line.content, state);
                for (const event of events) {
                    yield event;
                }
            }
        }
    }

    #buildStreamOutput(
        accumulatedText: string,
        reasoningDetails?: any,
        toolCalls?: any[],
        reasoningText?: string,
    ): any[] {
        const output: any[] = [];

        if (reasoningDetails && Array.isArray(reasoningDetails)) {
            for (const reasoningItem of reasoningDetails) {
                const outputItem: any = {
                    type: 'reasoning',
                    id:
                        reasoningItem.id ||
                        `reasoning-${Date.now()}-${reasoningItem.index || 0}`,
                    content: [],
                    providerData: reasoningItem,
                };

                if (
                    reasoningItem.type === 'reasoning.text' &&
                    reasoningItem.text
                ) {
                    outputItem.content.push({
                        type: 'input_text',
                        text: reasoningItem.text,
                        providerData: {
                            format: reasoningItem.format,
                            index: reasoningItem.index,
                        },
                    });
                } else if (
                    reasoningItem.type === 'reasoning.summary' &&
                    reasoningItem.summary
                ) {
                    outputItem.content.push({
                        type: 'input_text',
                        text: reasoningItem.summary,
                        providerData: {
                            format: reasoningItem.format,
                            index: reasoningItem.index,
                        },
                    });
                } else if (reasoningItem.type === 'reasoning.encrypted') {
                    outputItem.content = [];
                }

                output.push(outputItem);
            }
        }

        if (accumulatedText) {
            output.push({
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                    {
                        type: 'output_text',
                        text: accumulatedText,
                    },
                ],
                ...(typeof reasoningText === 'string' &&
                reasoningText.length > 0
                    ? {reasoning: reasoningText}
                    : {}),
                ...(reasoningDetails != null
                    ? {reasoning_details: reasoningDetails}
                    : {}),
            } as any);
        }

        if (toolCalls && toolCalls.length > 0) {
            for (const toolCall of toolCalls) {
                if (toolCall.type === 'function_call') {
                    // Note: arguments already decoded in #mergeToolCalls, don't double-decode
                    const args = toolCall.arguments;
                    output.push({
                        type: 'function_call',
                        callId: toolCall.callId,
                        name: toolCall.name,
                        arguments: args,
                        status: 'completed',
                        ...(typeof reasoningText === 'string' &&
                        reasoningText.length > 0
                            ? {reasoning: reasoningText}
                            : {}),
                        ...(reasoningDetails != null
                            ? {reasoning_details: reasoningDetails}
                            : {}),
                    } as any);
                }
            }
        }

        return output;
    }

    #mergeToolCalls(accumulatedCalls: any[], deltas: any[]): void {
        for (const delta of deltas) {
            const index = delta.index ?? accumulatedCalls.length;
            const existing =
                accumulatedCalls[index] ??
                ({
                    type: 'function_call',
                    callId: '',
                    name: '',
                    arguments: '',
                } as any);

            if (delta.id) {
                existing.callId += delta.id;
            }

            if (delta.function?.name) {
                existing.name += delta.function.name;
            }
            if (delta.function?.arguments) {
                existing.arguments += decodeHtmlEntities(
                    delta.function.arguments,
                );
            }

            accumulatedCalls[index] = existing;
        }
    }

    *#splitBufferIntoLines(
        buffer: string,
    ): Generator<{content: string; remainingBuffer: string}> {
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            yield {content: line, remainingBuffer: buffer};
        }
        yield {content: '', remainingBuffer: buffer};
    }

    *#processSSELine(line: string, state: any): Generator<any> {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        yield* this.#processSSEDataLine(data, state);
    }

    *#processSSEDataLine(data: string, state: any): Generator<any> {
        if (data === '[DONE]') {
            yield* this.#buildStreamCompleteEvent(state);
            return;
        }

        try {
            const json = JSON.parse(data);
            yield* this.#processStreamEventJSON(json, state);
        } catch (err) {
            this.#loggingService.error('OpenAI-compatible stream parse error', {
                err,
            });
        }
    }

    *#buildStreamCompleteEvent(state: any): Generator<any> {
        if (!state.responseId || state.responseId === 'unknown') {
            state.responseId = randomUUID();
        }

        const reasoningDetails =
            state.accumulatedReasoning.length > 0
                ? state.accumulatedReasoning
                : undefined;

        yield {
            type: 'response_done',
            response: {
                id: state.responseId,
                usage: normalizeUsage(state.usageData),
                output: this.#buildStreamOutput(
                    state.accumulated,
                    reasoningDetails,
                    state.accumulatedToolCalls,
                    state.accumulatedReasoningText,
                ),
            },
        } as any;

        yield {
            type: 'model',
            event: '[DONE]',
        };
    }

    *#processStreamEventJSON(json: any, state: any): Generator<any> {
        this.#extractStreamMetadata(json, state);
        this.#accumulateReasoningFromStream(json, state);
        this.#accumulateToolCallsFromStream(json, state);

        const contentDeltaEvent = this.#extractContentDelta(json, state);
        if (contentDeltaEvent) {
            yield contentDeltaEvent;
        }

        yield {
            type: 'model',
            event: json,
        };
    }

    #extractStreamMetadata(json: any, state: any): void {
        if (json?.id && state.responseId === 'unknown') {
            state.responseId = json.id;
        }
        if (json?.usage) {
            state.usageData = json.usage;
        }
    }

    #accumulateReasoningFromStream(json: any, state: any): void {
        const reasoningDetails = json?.choices?.[0]?.delta?.reasoning_details;
        if (reasoningDetails) {
            const TYPE_FIELD_MAP: Record<string, string> = {
                'reasoning.text': 'text',
                'reasoning.summary': 'summary',
                'reasoning.encrypted': 'data',
            };

            const reasoningMap = new Map(
                state.accumulatedReasoning.map((item: any) => [
                    `${item.type}:${item.index}`,
                    item,
                ]),
            );

            const details = !Array.isArray(reasoningDetails)
                ? [reasoningDetails]
                : reasoningDetails;

            for (const detail of details) {
                const {type, index} = detail;
                const fieldName = TYPE_FIELD_MAP[type];
                if (!fieldName) return;

                const key = `${type}:${index}`;
                const existing = reasoningMap.get(key);

                if (existing) {
                    existing[fieldName] += detail[fieldName];
                } else {
                    const newItem = {
                        ...detail,
                        [fieldName]: detail[fieldName],
                    };
                    state.accumulatedReasoning.push(newItem);
                    reasoningMap.set(key, newItem);
                }
            }
        }

        const reasoningDelta = json?.choices?.[0]?.delta?.reasoning || json?.choices?.[0]?.delta?.reasoning_content;
        if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
            state.accumulatedReasoningText += reasoningDelta;
        }
    }

    #accumulateToolCallsFromStream(json: any, state: any): void {
        const deltaToolCalls = json?.choices?.[0]?.delta?.tool_calls;
        if (deltaToolCalls) {
            this.#mergeToolCalls(state.accumulatedToolCalls, deltaToolCalls);
        }
    }

    #extractContentDelta(json: any, state: any): any | null {
        const delta = json?.choices?.[0]?.delta?.content ?? '';
        if (delta) {
            state.accumulated += delta;
            return {
                type: 'output_text_delta',
                delta,
            } as any;
        }
        return null;
    }

    #resolveModelFromRequest(req: ModelRequest): string | undefined {
        if ((req as any)?.providerData?.model)
            return (req as any).providerData.model;
        return undefined;
    }
}
