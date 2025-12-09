import {
    type ModelProvider,
    type Model,
    type ModelRequest,
    type ModelResponse,
    type ResponseStreamEvent,
} from '@openai/agents-core';
import {randomUUID} from 'node:crypto';
import {settingsService} from '../services/settings-service.js';
import {
	loggingService,
	loggingService as logger,
} from '../services/logging-service.js';

// Minimal OpenRouter Chat Completions client implementing the Agents Core Model interface.
//
// MODELREQUEST TO OPENROUTER MAPPING GUIDE:
//
// This provider maps all properties of the OpenAI Agents SDK's ModelRequest interface
// to OpenRouter's Chat Completions API format. Below is the complete mapping:
//
// ✓ FULLY COMPATIBLE (mapped directly):
//   - systemInstructions → {role: "system", content: string}
//   - input (string) → {role: "user", content: string}
//   - input (array) → {role: "user", content: string} (text items concatenated)
//   - modelSettings.temperature → temperature
//   - modelSettings.topP → top_p
//   - modelSettings.maxTokens → max_tokens
//   - modelSettings.topK → top_k
//   - modelSettings.frequencyPenalty → frequency_penalty
//   - modelSettings.presencePenalty → presence_penalty
//   - tools (function tools only) → tools array with function definitions
//   - signal → fetch() signal for cancellation
//
// ⚠ PARTIALLY SUPPORTED (requires transformation):
//   - input (image/document items) - skipped, text items extracted
//   - outputType - basic JSON mode only, not JSON Schema
//
// ✗ NOT SUPPORTED (ignored):
//   - previousResponseId - OpenRouter doesn't support response chaining
//   - conversationId - no conversation state API; manage history manually
//   - handoffs - SDK-specific multi-agent feature
//   - prompt - no prompt template storage
//   - overridePromptModel - only relevant with prompt templates
//   - modelSettings.seed - OpenAI-specific reproducibility
//   - modelSettings.truncation - OpenAI-specific strategy
//   - modelSettings.store - OpenAI prompt/response caching
//   - modelSettings.promptCacheRetention - OpenAI cache control
//   - modelSettings.responseFormatJsonSchema - OpenAI-specific
//   - tracing - used locally, not sent to API
//   - toolsExplicitlyProvided - internal SDK flag
//   - SDK-specific tools (ShellTool, ComputerTool) - filtered out
//
// IMPORTANT for custom provider implementers:
// The OpenAI Agents SDK has strict requirements for both ModelResponse structure AND stream event types.
// Incorrect event types or missing fields will cause runtime errors.
//
// Required stream event types (from @openai/agents-core/dist/types/protocol):
// - 'output_text_delta' - for streaming text chunks (NOT 'response.output_text.delta')
//   { type: 'output_text_delta', delta: string }
//
// - 'response_done' - for final response completion (NOT 'response.completed')
//   { type: 'response_done', response: { id: string, usage: {...}, output: [...] } }
//
// - 'response_started' - for response start (optional)
//
// See detailed comments below for ModelResponse.output structure requirements.

const OPENROUTER_BASE_URL =
    settingsService.get<string>('agent.openrouter.baseUrl') ||
    'https://openrouter.ai/api/v1';

const conversationHistory = new Map<string, any[]>();

function clearOpenRouterConversations(conversationId?: string): void {
    if (conversationId) {
        conversationHistory.delete(conversationId);
        return;
    }

    conversationHistory.clear();
}

// Convert OpenRouter usage format to OpenAI Agents SDK format
function normalizeUsage(openRouterUsage: any): {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
} {
    // OpenRouter returns: { prompt_tokens, completion_tokens, total_tokens }
    // SDK expects: { inputTokens, outputTokens, totalTokens }
    return {
        inputTokens: openRouterUsage?.prompt_tokens ?? 0,
        outputTokens: openRouterUsage?.completion_tokens ?? 0,
        totalTokens: openRouterUsage?.total_tokens ?? 0,
    };
}

function convertAgentItemToOpenRouterMessage(item: any): any | null {
    if (!item) {
        return null;
    }

    if (item.type === 'input_text' && typeof item.text === 'string') {
        return {role: 'user', content: item.text};
    }

    if (item.role === 'assistant' && item.type === 'message') {
        const message: any = {role: 'assistant'};
        if (Array.isArray(item.content)) {
            const textContent = item.content
                .filter((c: any) => c?.type === 'output_text' && c?.text)
                .map((c: any) => c.text)
                .join('');
            if (textContent) {
                message.content = textContent;
            }
        }

        if (item.reasoning_details) {
            message.reasoning_details = item.reasoning_details;
        }

        if (item.tool_calls) {
            message.tool_calls = item.tool_calls;
            message.content = null;
        }

        return message;
    }

    // Handle explicit user messages included in array-form inputs
    if (item.role === 'user' && item.type === 'message') {
        if (typeof item.content === 'string') {
            return {role: 'user', content: item.content};
        }

        if (Array.isArray(item.content)) {
            const textContent = item.content
                .filter((c: any) => (c?.type === 'input_text' || c?.type === 'output_text') && c?.text)
                .map((c: any) => c.text)
                .join('');
            if (textContent) {
                return {role: 'user', content: textContent};
            }
        }
    }

    const rawItem = item.rawItem || item;

    if (
        rawItem?.type === 'function_call' ||
        rawItem?.type === 'function_call_output'
    ) {
        return {
            role: 'assistant',
            content: null,
            tool_calls: [
                {
                    id: rawItem.callId || rawItem.id,
                    type: 'function',
                    function: {
                        name: rawItem.name,
                        arguments:
                            rawItem.arguments ??
                            (rawItem.args ? JSON.stringify(rawItem.args) : ''),
                    },
                },
            ],
        };
    }

    if (
        rawItem?.type === 'function_call_result' ||
        rawItem?.type === 'function_call_output_result'
    ) {
        let outputContent = '';
        if (typeof rawItem.output === 'string') {
            outputContent = rawItem.output;
        } else if (rawItem.output && typeof rawItem.output === 'object') {
            outputContent = JSON.stringify(rawItem.output);
        }

        return {
            role: 'tool',
            tool_call_id: rawItem.callId || rawItem.id,
            content: outputContent,
        };
    }

    return null;
}

function buildMessagesFromRequest(
    req: ModelRequest,
    conversationId: string | null,
): {messages: any[]; currentTurnMessages: any[]} {
    const messages: any[] = [];
    const currentTurnMessages: any[] = [];

    if (req.systemInstructions && req.systemInstructions.trim().length > 0) {
        messages.push({role: 'system', content: req.systemInstructions});
    }

    if (conversationId && conversationHistory.has(conversationId)) {
        messages.push(...(conversationHistory.get(conversationId) || []));
    }

    if (typeof req.input === 'string') {
        const userMessage = {role: 'user', content: req.input};
        messages.push(userMessage);
        currentTurnMessages.push(userMessage);
    } else if (Array.isArray(req.input)) {
        for (const item of req.input as any[]) {
            const converted = convertAgentItemToOpenRouterMessage(item);
            if (converted) {
                messages.push(converted);
                currentTurnMessages.push(converted);
            }
        }
    }

    return {messages, currentTurnMessages};
}

// Extract function tools from ModelRequest tools array
// SDK Property: tools (SerializedTool[])
// OpenRouter Mapping: tools array in request body with function definitions
function extractFunctionToolsFromRequest(req: ModelRequest): any[] {
    if (!req.tools || req.tools.length === 0) {
        return [];
    }

    const functionTools: any[] = [];

    for (const tool of req.tools as any[]) {
        if (tool.type === 'function') {
            functionTools.push({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                    strict: tool.strict,
                },
            });
        }
    }

    return functionTools;
}

// Map ModelSettings to OpenRouter request parameters
// SDK Property: modelSettings (ModelSettings)
// OpenRouter Mapping: Direct parameter mapping
function extractModelSettingsForRequest(settings: any): any {
    const body: any = {};

    if (settings) {
        // Temperature: Supported by both SDK and OpenRouter
        if (settings.temperature != null) body.temperature = settings.temperature;

        // Top P: Supported by both (SDK uses topP, OpenRouter uses top_p)
        if (settings.topP != null) body.top_p = settings.topP;

        // Max Tokens: Supported by both (SDK uses maxTokens, OpenRouter uses max_tokens)
        if (settings.maxTokens != null) body.max_tokens = settings.maxTokens;

        // Top K: Supported by some models via OpenRouter
        if (settings.topK != null) body.top_k = settings.topK;

        // Frequency Penalty: OpenAI standard parameter
        if (settings.frequencyPenalty != null) body.frequency_penalty = settings.frequencyPenalty;

        // Presence Penalty: OpenAI standard parameter
        if (settings.presencePenalty != null) body.presence_penalty = settings.presencePenalty;

        const reasoningEffort =
            settings.reasoningEffort ?? settings.reasoning?.effort;
        const normalizedEffort =
            reasoningEffort === 'default' ? 'medium' : reasoningEffort;

        if (normalizedEffort && normalizedEffort !== 'none') {
            body.reasoning = {
                ...(settings.reasoning ?? {}),
                effort: normalizedEffort,
            };
        }

        // NOTE: The following ModelSettings properties are OpenAI-specific and NOT sent to OpenRouter:
        // - seed: OpenAI reproducibility feature
        // - truncation: OpenAI-specific truncation strategy
        // - store: OpenAI prompt/response caching
        // - promptCacheRetention: OpenAI cache control
        // - responseFormat: Partially supported (basic JSON mode only, not JSON schema)
        // - responseFormatJsonSchema: OpenAI-specific (not all models support)
    }

    return body;
}

async function callOpenRouter({
    apiKey,
    model,
    messages,
    stream,
    signal,
    settings,
    tools,
}: {
    apiKey: string;
    model: string;
    messages: any[];
    stream: boolean;
    signal?: AbortSignal;
    settings?: any;
    tools?: any[];
}): Promise<Response> {
    const url = `${OPENROUTER_BASE_URL}/chat/completions`;
    const body: any = {
        model,
        messages,
        stream,
    };

    // Merge settings into request body
    const settingsParams = extractModelSettingsForRequest(settings);
    Object.assign(body, settingsParams);

    // Add tools if provided
    const functionTools = tools ?? [];
    body.tools = functionTools;
    if (functionTools.length > 0) {
        body.tool_choice = 'auto'; // Let model choose when to use tools
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer':
                settingsService.get<string>('agent.openrouter.referrer') ||
                'http://localhost',
            'X-Title':
                settingsService.get<string>('agent.openrouter.title') || 'term2',
        },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        let errText: any;
        try {
            errText = await res.text();
        } catch {}
        throw new Error(
            `OpenRouter request failed: ${res.status} ${res.statusText}${
                errText ? ` - ${errText}` : ''
            }`,
        );
    }
    return res;
}

class OpenRouterModel implements Model {
    name: string;
    #modelId: string;
    #conversationHistory = conversationHistory;
    constructor(modelId?: string) {
        this.name = 'OpenRouter';
        this.#modelId =
            modelId ||
            settingsService.get<string>('agent.openrouter.model') ||
            'openrouter/auto';
    }

    async getResponse(request: ModelRequest): Promise<ModelResponse> {
        const apiKey = settingsService.get<string>('agent.openrouter.apiKey');
        if (!apiKey) {
            throw new Error('OPENROUTER_API_KEY is not set');
        }
        const conversationId = request.previousResponseId ?? null;
        const {messages, currentTurnMessages} = buildMessagesFromRequest(
            request,
            conversationId,
        );

        logger.debug('OpenRouter message', {messages});

        // Extract function tools from ModelRequest
        // SDK Property: tools (SerializedTool[])
        // Note: SDK-specific tools (shell, computer, etc.) are filtered out here
        const tools = extractFunctionToolsFromRequest(request);

        const res = await callOpenRouter({
            apiKey,
            model: this.#resolveModelFromRequest(request) || this.#modelId,
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

        const responseId = json?.id ?? conversationId ?? randomUUID();

        const usage = normalizeUsage(json?.usage || {}) as any;
        const reasoningDetails = choice?.message?.reasoning_details;
        const toolCalls = choice?.message?.tool_calls;

        this.#storeConversationTurn({
            conversationId,
            responseId,
            currentTurnMessages,
            assistantMessage: this.#buildAssistantHistoryMessage({
                content: textContent,
                reasoningDetails,
                toolCalls,
            }),
        });

        // Build output array with message, reasoning, and tool calls
        const output: any[] = [];

        // Add reasoning items as separate output items (if present)
        if (reasoningDetails && Array.isArray(reasoningDetails)) {
            for (const reasoningItem of reasoningDetails) {
                const outputItem: any = {
                    type: 'reasoning',
                    id: reasoningItem.id || `reasoning-${Date.now()}-${reasoningItem.index || 0}`,
                    content: [],
                    providerData: reasoningItem,
                };

                // Handle different reasoning types
                if (reasoningItem.type === 'reasoning.text' && reasoningItem.text) {
                    outputItem.content.push({
                        type: 'input_text',
                        text: reasoningItem.text,
                        providerData: {
                            format: reasoningItem.format,
                            index: reasoningItem.index,
                        },
                    });
                } else if (reasoningItem.type === 'reasoning.summary' && reasoningItem.summary) {
                    outputItem.content.push({
                        type: 'input_text',
                        text: reasoningItem.summary,
                        providerData: {
                            format: reasoningItem.format,
                            index: reasoningItem.index,
                        },
                    });
                } else if (reasoningItem.type === 'reasoning.encrypted') {
                    // Encrypted reasoning has no text content, only providerData
                    outputItem.content = [];
                }
                // For any other reasoning types, store in providerData and leave content empty

                output.push(outputItem);
            }
        }

        // Add assistant message only if there's text content
        // (Don't add empty message when there are only tool calls)
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
            } as any);
        }

        // Add tool calls as separate output items
        // Note: Non-streaming response has OpenRouter format with nested function object
        if (toolCalls && toolCalls.length > 0) {
            for (const toolCall of toolCalls) {
                if (toolCall.type === 'function') {
                    output.push({
                        type: 'function_call',
                        callId: toolCall.id,
                        name: toolCall.function.name,
                        arguments: toolCall.function.arguments,
                        status: 'completed',
                    } as any);
                }
            }
        }

        const response: ModelResponse = {
            usage,
            output,
            responseId,
            providerData: json,
        };
        return response;
    }

    async *getStreamedResponse(
        request: ModelRequest,
    ): AsyncIterable<ResponseStreamEvent> {
        const apiKey = settingsService.get<string>('agent.openrouter.apiKey');
        if (!apiKey) {
            throw new Error('OPENROUTER_API_KEY is not set');
        }
        const conversationId = request.previousResponseId ?? null;
        const {messages, currentTurnMessages} = buildMessagesFromRequest(
            request,
            conversationId,
        );

        const tools = extractFunctionToolsFromRequest(request);

        loggingService.debug('OpenRouter stream start', {
            conversationId,
            messageCount: Array.isArray(messages) ? messages.length : 0,
            messages,
            toolsCount: Array.isArray(tools) ? tools.length : 0,
            tools,
        });

        const res = await callOpenRouter({
            apiKey,
            model: this.#resolveModelFromRequest(request) || this.#modelId,
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
        let responseId = conversationId ?? 'unknown';
        let usageData: any = null;
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
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream: true});
            let idx: number;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (!line) continue;
                if (line.startsWith('data:')) {
                    const data = line.slice(5).trim();
                    if (data === '[DONE]') {
                        if (!responseId || responseId === 'unknown') {
                            responseId = conversationId ?? randomUUID();
                        }
                        const reasoningDetails =
                            accumulatedReasoning.length > 0
                                ? accumulatedReasoning
                                : undefined;

                        this.#storeConversationTurn({
                            conversationId,
                            responseId,
                            currentTurnMessages,
                            assistantMessage: this.#buildAssistantHistoryMessage(
                                {
                                    content: accumulated,
                                    reasoningDetails,
                                    toolCalls: accumulatedToolCalls,
                                },
                            ),
                        });

                        yield {
                            type: 'response_done',
                            response: {
                                id: responseId,
                                usage: normalizeUsage(usageData),
                                output: this.#buildStreamOutput(
                                    accumulated,
                                    reasoningDetails,
                                    accumulatedToolCalls,
                                ),
                            },
                        } as any;
						yield {
							type: 'model',
							event: data
						}
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        if (json?.id && responseId === 'unknown') {
                            responseId = json.id;
                        }
                        if (json?.usage) {
                            usageData = json.usage;
                        }
                        const reasoningDetails =
                            json?.choices?.[0]?.delta?.reasoning_details;
                        if (reasoningDetails) {
                            if (Array.isArray(reasoningDetails)) {
                                accumulatedReasoning.push(...reasoningDetails);
                            } else {
                                accumulatedReasoning.push(reasoningDetails);
                            }
                        }
                        const deltaToolCalls =
                            json?.choices?.[0]?.delta?.tool_calls;
                        if (deltaToolCalls) {
                            this.#mergeToolCalls(accumulatedToolCalls, deltaToolCalls);
                        }
                        const delta =
                            json?.choices?.[0]?.delta?.content ?? '';
                        if (delta) {
                            accumulated += delta;
                            yield {
                                type: 'output_text_delta',
                                delta,
                            } as any;
                        }
						yield {
							type: 'model',
							event: json
						}
                    } catch {
                        // ignore parse errors for keep-alive lines
                    }
                }
            }
        }
        const reasoningDetails =
            accumulatedReasoning.length > 0 ? accumulatedReasoning : undefined;

        if (!responseId || responseId === 'unknown') {
            responseId = conversationId ?? randomUUID();
        }

        this.#storeConversationTurn({
            conversationId,
            responseId,
            currentTurnMessages,
            assistantMessage: this.#buildAssistantHistoryMessage({
                content: accumulated,
                reasoningDetails,
                toolCalls: accumulatedToolCalls,
            }),
        });

        yield {
            type: 'response_done',
            response: {
                id: responseId,
                usage: normalizeUsage(usageData),
                output: this.#buildStreamOutput(
                    accumulated,
                    reasoningDetails,
                    accumulatedToolCalls,
                ),
            },
        } as any;
    }

    #buildStreamOutput(
        accumulated: string,
        reasoningDetails?: any,
        toolCalls?: any[],
    ): any[] {
        const output: any[] = [];

        // Add reasoning items as separate output items (if present)
        if (reasoningDetails && Array.isArray(reasoningDetails)) {
            for (const reasoningItem of reasoningDetails) {
                const outputItem: any = {
                    type: 'reasoning',
                    id: reasoningItem.id || `reasoning-${Date.now()}-${reasoningItem.index || 0}`,
                    content: [],
                    providerData: reasoningItem,
                };

                // Handle different reasoning types
                if (reasoningItem.type === 'reasoning.text' && reasoningItem.text) {
                    outputItem.content.push({
                        type: 'input_text',
                        text: reasoningItem.text,
                        providerData: {
                            format: reasoningItem.format,
                            index: reasoningItem.index,
                        },
                    });
                } else if (reasoningItem.type === 'reasoning.summary' && reasoningItem.summary) {
                    outputItem.content.push({
                        type: 'input_text',
                        text: reasoningItem.summary,
                        providerData: {
                            format: reasoningItem.format,
                            index: reasoningItem.index,
                        },
                    });
                } else if (reasoningItem.type === 'reasoning.encrypted') {
                    // Encrypted reasoning has no text content, only providerData
                    outputItem.content = [];
                }
                // For any other reasoning types, store in providerData and leave content empty

                output.push(outputItem);
            }
        }

        // Add assistant message only if there's text content
        // (Don't add empty message when there are only tool calls)
        if (accumulated) {
            output.push({
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                    {
                        type: 'output_text',
                        text: accumulated,
                    },
                ],
            } as any);
        }

        // Add tool calls as separate output items
        // Note: Streaming response has SDK format with flat structure
        if (toolCalls && toolCalls.length > 0) {
            for (const toolCall of toolCalls) {
                if (toolCall.type === 'function_call') {
                    output.push({
                        type: 'function_call',
                        callId: toolCall.callId,
                        name: toolCall.name,
                        arguments: toolCall.arguments,
                        status: 'completed',
                    } as any);
                }
            }
        }

        return output;
    }

    #buildAssistantHistoryMessage({
        content,
        reasoningDetails,
        toolCalls,
    }: {
        content: string;
        reasoningDetails?: any;
        toolCalls?: any[];
    }): any {
        const assistantMessage: any = {
            role: 'assistant',
        };

        if (toolCalls && toolCalls.length > 0) {
            // Convert SDK format (type: 'function_call') to OpenRouter format (type: 'function')
            assistantMessage.tool_calls = toolCalls.map((tc) => {
                if (tc.type === 'function_call') {
                    // SDK format -> OpenRouter format
                    return {
                        id: tc.callId,
                        type: 'function',
                        function: {
                            name: tc.name,
                            arguments: tc.arguments,
                        },
                    };
                }
                // Already in OpenRouter format
                return tc;
            });
            assistantMessage.content = null;
        } else {
            assistantMessage.content = content;
        }

        if (reasoningDetails) {
            assistantMessage.reasoning_details = reasoningDetails;
        }

        return assistantMessage;
    }

    #mergeToolCalls(accumulated: any[], deltas: any[]): void {
        for (const delta of deltas) {
            const index = delta.index ?? accumulated.length;
            const existing =
                accumulated[index] ??
                ({
                    type: 'function_call',
                    callId: '',
                    name: '',
                    arguments: '',
                } as any);

            // Accumulate the callId (id comes in deltas)
            if (delta.id) {
                existing.callId += delta.id;
            }

            // Accumulate function name and arguments
            if (delta.function?.name) {
                existing.name += delta.function.name;
            }
            if (delta.function?.arguments) {
                existing.arguments += delta.function.arguments;
            }

            accumulated[index] = existing;
        }
    }

    #storeConversationTurn({
        conversationId,
        responseId,
        currentTurnMessages,
        assistantMessage,
    }: {
        conversationId: string | null;
        responseId?: string | null;
        currentTurnMessages: any[];
        assistantMessage: any;
    }): void {
        const baseHistory =
            (conversationId ? this.#conversationHistory.get(conversationId) : []) ||
            [];
        const mergedHistory = [
            ...baseHistory,
            ...currentTurnMessages.filter(Boolean),
        ];

        if (assistantMessage) {
            mergedHistory.push(assistantMessage);
        }

        const targetId =
            (responseId && responseId !== 'unknown' ? responseId : null) ||
            conversationId ||
            randomUUID();
        if (!targetId) {
            return;
        }

        this.#conversationHistory.set(targetId, mergedHistory);
        if (conversationId && conversationId !== targetId) {
            this.#conversationHistory.set(conversationId, mergedHistory);
        }
    }

    clearConversation(conversationId: string | null): void {
        if (!conversationId) return;
        this.#conversationHistory.delete(conversationId);
    }

    clearAllConversations(): void {
        this.#conversationHistory.clear();
    }

    #resolveModelFromRequest(req: ModelRequest): string | undefined {
        // If the agent explicitly set a model override in the prompt, prefer the runtime model.
        // For now, just return undefined to use constructor/default.
        if ((req as any)?.providerData?.model) return (req as any).providerData.model;
        return undefined;
    }
}

class OpenRouterProvider implements ModelProvider {
    getModel(modelName?: string): Promise<Model> | Model {
        return new OpenRouterModel(modelName);
    }
}

export {
    OpenRouterModel,
    OpenRouterProvider,
    clearOpenRouterConversations,
};
