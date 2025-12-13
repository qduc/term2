import {
    type ModelProvider,
    type Model,
    type ModelRequest,
    type ModelResponse,
    type ResponseStreamEvent,
} from '@openai/agents-core';
import {randomUUID} from 'node:crypto';
import type {ILoggingService, ISettingsService} from '../services/service-interfaces.js';

/**
 * Custom error class for OpenRouter API errors
 * Includes status code and headers for proper retry logic
 */
export class OpenRouterError extends Error {
	status: number;
	headers: Record<string, string>;
	responseBody?: string;

	constructor(message: string, status: number, headers: Record<string, string>, responseBody?: string) {
		super(message);
		this.name = 'OpenRouterError';
		this.status = status;
		this.headers = headers;
		this.responseBody = responseBody;
	}
}

// Helper function to decode common HTML entities in tool call arguments
function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'");
}

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

function getOpenRouterBaseUrl(settingsService: ISettingsService): string {
    return settingsService.get('agent.openrouter.baseUrl') || 'https://openrouter.ai/api/v1';
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

	const rawItem = item.rawItem || item;

    if (rawItem.type === 'input_text' && typeof rawItem.text === 'string') {
        return {role: 'user', content: rawItem.text};
    }

    if (rawItem.role === 'assistant' && rawItem.type === 'message') {
        const message: any = {role: 'assistant'};
        if (Array.isArray(rawItem.content)) {
            const textContent = rawItem.content
                .filter((c: any) => c?.type === 'output_text' && c?.text)
                .map((c: any) => c.text)
                .join('');
            if (textContent) {
                message.content = textContent;
            }
        }

		// Preserve OpenRouter "reasoning" field (aka reasoning tokens) when present.
		// This is distinct from reasoning_details blocks.
		const reasoning = rawItem.reasoning ?? item.reasoning;
		if (typeof reasoning === 'string') {
			message.reasoning = reasoning;
		}

        // Preserve reasoning_details EXACTLY as received (required by OpenRouter).
        // Some SDK history items may carry these fields under `rawItem`.
        const reasoningDetails =
			rawItem.reasoning_details ?? item.reasoning_details;
        if (reasoningDetails != null) {
            message.reasoning_details = reasoningDetails;
        }

        const toolCalls = rawItem.tool_calls ?? item.tool_calls;
        if (toolCalls != null) {
            message.tool_calls = toolCalls;
        }

        return message;
    }

    // Handle explicit user messages included in array-form inputs
    if (rawItem.role === 'user' && rawItem.type === 'message') {
        if (typeof rawItem.content === 'string') {
            return {role: 'user', content: rawItem.content};
        }

        if (Array.isArray(rawItem.content)) {
            const textContent = rawItem.content
                .filter((c: any) => (c?.type === 'input_text' || c?.type === 'output_text') && c?.text)
                .map((c: any) => c.text)
                .join('');
            if (textContent) {
                return {role: 'user', content: textContent};
            }
        }
    }

    if (rawItem?.type === 'function_call') {
		// Tool-call continuation: to preserve reasoning blocks across tool flows,
		// we may need to replay reasoning_details/reasoning alongside tool_calls.
		const reasoning = rawItem.reasoning ?? item.reasoning;
		const reasoningDetails =
			rawItem.reasoning_details ?? item.reasoning_details;

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
			...(typeof reasoning === 'string' ? {reasoning} : {}),
			...(reasoningDetails != null
				? {reasoning_details: reasoningDetails}
				: {}),
        };
    }

    if (
        rawItem?.type === 'function_call_output' ||
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

/**
 * Check if the model is an Anthropic/Claude model.
 * Anthropic models support prompt caching via cache_control breakpoints.
 */
function isAnthropicModel(modelId: string): boolean {
    const lowerModelId = modelId.toLowerCase();
    return lowerModelId.includes('anthropic') || lowerModelId.includes('claude');
}

function buildMessagesFromRequest(
    req: ModelRequest,
    modelId?: string,
): any[] {
    const messages: any[] = [];
	let pendingReasoningDetails: any[] = [];

    if (req.systemInstructions && req.systemInstructions.trim().length > 0) {
        // For Anthropic models, use array format with cache_control for prompt caching.
        // This enables caching of the system message (agent instructions) which is large and rarely changes.
        // See: https://openrouter.ai/docs/guides/best-practices/prompt-caching#anthropic-claude
        if (modelId && isAnthropicModel(modelId)) {
            messages.push({
                role: 'system',
                content: [
                    {
                        type: 'text',
                        text: req.systemInstructions,
                        cache_control: {type: 'ephemeral'},
                    },
                ],
            });
        } else {
            messages.push({role: 'system', content: req.systemInstructions});
        }
    }

    // Note: History is managed by the SDK
    // The SDK provides full conversation context in req.input

    if (typeof req.input === 'string') {
        const userMessage = {role: 'user', content: req.input};
        messages.push(userMessage);
    } else if (Array.isArray(req.input)) {
        for (const item of req.input as any[]) {
            // The Agents SDK may represent preserved reasoning blocks as standalone
            // output items of type "reasoning" (with providerData containing the
            // original reasoning detail object). Gemini models require these blocks
            // to be replayed as reasoning_details in subsequent requests.
            const raw = (item as any)?.rawItem ?? item;
            if (raw?.type === 'reasoning') {
                const detail = raw?.providerData ?? (item as any)?.providerData;
                if (detail && typeof detail === 'object') {
                    pendingReasoningDetails.push(detail);
                }
                continue;
            }

            const converted = convertAgentItemToOpenRouterMessage(item);
            if (converted) {
                // Attach any pending reasoning blocks to the next assistant message we
                // emit (including assistant tool_calls messages), unless already present.
                if (
                    pendingReasoningDetails.length > 0 &&
                    converted.role === 'assistant' &&
                    converted.reasoning_details == null
                ) {
                    converted.reasoning_details = pendingReasoningDetails;
                    pendingReasoningDetails = [];
                }
                messages.push(converted);
            }
        }
    }

    // For Anthropic models, add cache_control to the last user message.
    // This is an efficient caching strategy using 2 of 4 available cache points:
    // 1. System message (static, large) - already cached above
    // 2. Last user message (marks end of reusable conversation history)
    // As the conversation grows, the cache automatically moves with the last user message.
    // See: https://openrouter.ai/docs/guides/best-practices/prompt-caching#anthropic-claude
    if (modelId && isAnthropicModel(modelId)) {
        addCacheControlToLastUserMessage(messages);
    }

    return messages;
}

/**
 * Add cache_control to the last user message in the messages array.
 * Transforms both string and array content formats appropriately.
 */
function addCacheControlToLastUserMessage(messages: any[]): void {
    // Find the last user message by iterating from the end
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'user') {
            // Transform the message content to include cache_control
            if (typeof msg.content === 'string') {
                // Convert string content to array format with cache_control
                msg.content = [
                    {
                        type: 'text',
                        text: msg.content,
                        cache_control: {type: 'ephemeral'},
                    },
                ];
            } else if (Array.isArray(msg.content) && msg.content.length > 0) {
                // Add cache_control to the last text item in the array
                for (let j = msg.content.length - 1; j >= 0; j--) {
                    const item = msg.content[j];
                    if (item.type === 'text') {
                        item.cache_control = {type: 'ephemeral'};
                        break;
                    }
                }
            }
            break; // Only process the last user message
        }
    }
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

        const hasReasoningObj =
            settings.reasoning && typeof settings.reasoning === 'object';
        if (hasReasoningObj) {
            // Pass through the full reasoning object unmodified. (OpenRouter supports
            // additional fields like max_tokens and exclude.)
            body.reasoning = {...settings.reasoning};
        }

        const reasoningEffort =
            settings.reasoningEffort ?? settings.reasoning?.effort;
        const normalizedEffort =
            reasoningEffort === 'default' ? 'medium' : reasoningEffort;

        // If an effort is provided (and isn't explicitly disabled), ensure it's set.
        if (normalizedEffort && normalizedEffort !== 'none') {
            body.reasoning = {
                ...(body.reasoning ?? {}),
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
    settingsService,
}: {
    apiKey: string;
    model: string;
    messages: any[];
    stream: boolean;
    signal?: AbortSignal;
    settings?: any;
    tools?: any[];
    settingsService: ISettingsService;
}): Promise<Response> {
    const url = `${getOpenRouterBaseUrl(settingsService)}/chat/completions`;
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
                settingsService.get('agent.openrouter.referrer') ||
                'http://localhost',
            'X-Title':
                settingsService.get('agent.openrouter.title') || 'term2',
        },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        let errText: any;
        try {
            errText = await res.text();
        } catch {}

        // Extract headers for retry logic (especially Retry-After)
        const headers: Record<string, string> = {};
        res.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
        });

        const message = `OpenRouter request failed: ${res.status} ${res.statusText}${
            errText ? ` - ${errText}` : ''
        }`;

        throw new OpenRouterError(message, res.status, headers, errText);
    }
    return res;
}

class OpenRouterModel implements Model {
    name: string;
    #modelId: string;
    #settingsService: ISettingsService;
    #loggingService: ILoggingService;

    constructor(deps: {
        settingsService: ISettingsService;
        loggingService: ILoggingService;
        modelId?: string;
    }) {
        this.name = 'OpenRouter';
        this.#settingsService = deps.settingsService;
        this.#loggingService = deps.loggingService;
        this.#modelId =
            deps.modelId ||
            this.#settingsService.get('agent.openrouter.model') ||
            'openrouter/auto';
    }

    async getResponse(request: ModelRequest): Promise<ModelResponse> {
        const apiKey = this.#settingsService.get('agent.openrouter.apiKey');
        if (!apiKey) {
            throw new Error(
                'OpenRouter API key is not configured. Please set the OPENROUTER_API_KEY environment variable. ' +
                'Get your API key from: https://openrouter.ai/keys'
            );
        }
        // OpenRouter does not support server-side response chaining the same way
        // as OpenAI Responses. We intentionally ignore previousResponseId and
        // expect the caller to provide full conversation context in `input`.
        // Note: History is managed by the SDK, not by this provider.
        const resolvedModelId = this.#resolveModelFromRequest(request) || this.#modelId;
        const messages = buildMessagesFromRequest(request, resolvedModelId);

        this.#loggingService.debug('OpenRouter message', {messages});

        // Extract function tools from ModelRequest
        // SDK Property: tools (SerializedTool[])
        // Note: SDK-specific tools (shell, computer, etc.) are filtered out here
        const tools = extractFunctionToolsFromRequest(request);

        const res = await callOpenRouter({
            apiKey,
            model: resolvedModelId,
            messages,
            stream: false,
            signal: request.signal,
            settings: request.modelSettings,
            tools,
            settingsService: this.#settingsService,
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
		const reasoning = choice?.message?.reasoning;
        const reasoningDetails = choice?.message?.reasoning_details;
        const toolCalls = choice?.message?.tool_calls;

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
				...(typeof reasoning === 'string' ? {reasoning} : {}),
				...(reasoningDetails != null
					? {reasoning_details: reasoningDetails}
					: {}),
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
                        arguments: decodeHtmlEntities(toolCall.function.arguments),
                        status: 'completed',
						// Preserve reasoning blocks/tokens on tool calls so that when the
						// caller replays history, we can attach them back onto the assistant
						// tool_calls message (OpenRouter best practice).
						...(typeof reasoning === 'string' ? {reasoning} : {}),
						...(reasoningDetails != null
							? {reasoning_details: reasoningDetails}
							: {}),
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
        const apiKey = this.#settingsService.get('agent.openrouter.apiKey');
        if (!apiKey) {
            throw new Error(
                'OpenRouter API key is not configured. Please set the OPENROUTER_API_KEY environment variable. ' +
                'Get your API key from: https://openrouter.ai/keys'
            );
        }
        // See getResponse(): caller-managed history; do not chain via previousResponseId.
        // Note: History is managed by the SDK, not by this provider.
        const resolvedModelId = this.#resolveModelFromRequest(request) || this.#modelId;
        const messages = buildMessagesFromRequest(request, resolvedModelId);

        const tools = extractFunctionToolsFromRequest(request);

        this.#loggingService.debug('OpenRouter stream start', {
            messageCount: Array.isArray(messages) ? messages.length : 0,
            messages,
            toolsCount: Array.isArray(tools) ? tools.length : 0,
            tools,
        });
        this.#loggingService.debug('modelRequest', request)
        this.#loggingService.debug('OpenRouter messages', {messages})

        const res = await callOpenRouter({
            apiKey,
            model: resolvedModelId,
            messages,
            stream: true,
            signal: request.signal,
            settings: request.modelSettings,
            tools,
            settingsService: this.#settingsService,
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
                            responseId = randomUUID();
                        }
                        const reasoningDetails =
                            accumulatedReasoning.length > 0
                                ? accumulatedReasoning
                                : undefined;

						this.#loggingService.debug('OpenRouter stream done', {
							text: accumulated,
							reasoningDetails,
							toolCalls: accumulatedToolCalls,
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
							accumulatedReasoningText,
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
						const reasoningDelta =
							json?.choices?.[0]?.delta?.reasoning;
						if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
							accumulatedReasoningText += reasoningDelta;
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
                    } catch (err) {
                        // ignore parse errors for keep-alive lines
						this.#loggingService.error('OpenRouter stream parse error', {err})
                    }
                }
            }
        }

		// It never runs to here
        const reasoningDetails =
            accumulatedReasoning.length > 0 ? accumulatedReasoning : undefined;

        if (!responseId || responseId === 'unknown') {
            responseId = randomUUID();
        }

		this.#loggingService.debug('OpenRouter stream done', {
			text: accumulated,
			reasoningDetails,
			toolCalls: accumulatedToolCalls,
		})

        yield {
            type: 'response_done',
            response: {
                id: responseId,
                usage: normalizeUsage(usageData),
                output: this.#buildStreamOutput(
                    accumulated,
                    reasoningDetails,
                    accumulatedToolCalls,
					accumulatedReasoningText,
                ),
            },
        } as any;
    }

    #buildStreamOutput(
        accumulated: string,
        reasoningDetails?: any,
        toolCalls?: any[],
		reasoningText?: string,
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
				...(typeof reasoningText === 'string' && reasoningText.length > 0
					? {reasoning: reasoningText}
					: {}),
				...(reasoningDetails != null
					? {reasoning_details: reasoningDetails}
					: {}),
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
                        arguments: decodeHtmlEntities(toolCall.arguments),
                        status: 'completed',
						...(typeof reasoningText === 'string' && reasoningText.length > 0
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
                existing.arguments += decodeHtmlEntities(delta.function.arguments);
            }

            accumulated[index] = existing;
        }
    }

    #resolveModelFromRequest(req: ModelRequest): string | undefined {
        // If the agent explicitly set a model override in the prompt, prefer the runtime model.
        // For now, just return undefined to use constructor/default.
        if ((req as any)?.providerData?.model) return (req as any).providerData.model;
        return undefined;
    }
}

class OpenRouterProvider implements ModelProvider {
    #settingsService: ISettingsService;
    #loggingService: ILoggingService;

    constructor(deps: {
        settingsService: ISettingsService;
        loggingService: ILoggingService;
    }) {
        this.#settingsService = deps.settingsService;
        this.#loggingService = deps.loggingService;
    }

    getModel(modelName?: string): Promise<Model> | Model {
        return new OpenRouterModel({
            settingsService: this.#settingsService,
            loggingService: this.#loggingService,
            modelId: modelName,
        });
    }
}

// Export factory function for dependency injection
export function createOpenRouterProvider(deps: {
    settingsService: ISettingsService;
    loggingService: ILoggingService;
}): OpenRouterProvider {
    return new OpenRouterProvider(deps);
}

export {
    OpenRouterModel,
    OpenRouterProvider,
};
