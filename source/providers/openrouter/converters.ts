import {type ModelRequest} from '@openai/agents-core';
import type {ILoggingService} from '../../services/service-interfaces.js';
import {isAnthropicModel} from './utils.js';

// No-op logger for fallback when loggingService is not provided
const noOpLogger: ILoggingService = {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
    security: () => {},
    setCorrelationId: () => {},
    getCorrelationId: () => undefined,
    clearCorrelationId: () => {},
};

/**
 * Converts an agent item into a structured OpenRouter message object that adheres to
 * expected formats for roles such as user, assistant, or tool, based on the item's properties.
 * Supports handling various item types like input text, messages, function calls, and function call outputs.
 *
 * @param {any} item - The agent item to be converted. It may represent different types of messages
 * (e.g., user input, assistant messages, tool calls) and can contain nested properties like rawItem, content,
 * reasoning, tool calls, or reasoning details.
 * @param {ILoggingService} loggingService - Logging service for debug output
 *
 * @return {any|null} - Returns a structured OpenRouter message object with specified properties like `role`,
 * `content`, `reasoning`, `reasoning_details`, or `tool_calls`. Returns `null` if the input `item` is null or
 * cannot be converted into a recognized format.
 */
function convertAgentItemToOpenRouterMessage(
    item: any,
    loggingService: ILoggingService,
): any | null {
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

        const reasoningContent = rawItem.reasoning_content ?? item.reasoning_content;
        if (typeof reasoningContent === 'string') {
            message.reasoning_content = reasoningContent;
        }

        // Preserve reasoning_details EXACTLY as received (required by OpenRouter).
        // Some SDK history items may carry these fields under `rawItem`.
        const reasoningDetails =
            rawItem.reasoning_details ?? item.reasoning_details;
        if (reasoningDetails != null) {
            loggingService.debug(
                'convertAgentItemToOpenRouterMessage: reasoning_details',
                reasoningDetails,
            );
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
                .filter(
                    (c: any) =>
                        (c?.type === 'input_text' ||
                            c?.type === 'output_text') &&
                        c?.text,
                )
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
        const reasoningContent = rawItem.reasoning_content ?? item.reasoning_content;
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
            ...(typeof reasoningContent === 'string'
                ? { reasoning_content: reasoningContent }
                : {}),
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

export function addCacheControlToLastUserMessage(messages: any[]): void {
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

export function addCacheControlToLastToolMessage(messages: any[]): void {
    // Find the last tool message by iterating from the end
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'tool') {
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
            break; // Only process the last tool message
        }
    }
}

export function buildMessagesFromRequest(
    req: ModelRequest,
    modelId?: string,
    loggingService?: ILoggingService,
): any[] {
    const messages: any[] = [];
    let pendingReasoningDetails: any[] = [];

    const logger = loggingService || noOpLogger;
    logger.debug('buildMessagesFromRequest: req.input', {
        inputType: typeof req.input,
        isArray: Array.isArray(req.input),
        inputLength: Array.isArray(req.input)
            ? req.input.length
            : typeof req.input === 'string'
            ? req.input.length
            : 'N/A',
        inputPreview: Array.isArray(req.input)
            ? req.input.map((item: any) => ({
                  role: item?.role || item?.rawItem?.role,
                  type: item?.type || item?.rawItem?.type,
              }))
            : typeof req.input === 'string'
            ? req.input.substring(0, 100)
            : 'non-string, non-array',
    });

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

            const converted = convertAgentItemToOpenRouterMessage(
                item,
                loggingService || noOpLogger,
            );
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

                const lastMessage = messages[messages.length - 1];

                // Merge consecutive messages with the same role
                if (lastMessage && lastMessage.role === converted.role) {
                    if (converted.role === 'assistant') {
                        // Merge content
                        if (converted.content != null) {
                            if (lastMessage.content == null) {
                                lastMessage.content = converted.content;
                            } else {
                                lastMessage.content =
                                    String(lastMessage.content) +
                                    '\n' +
                                    String(converted.content);
                            }
                        }

                        // Merge tool calls
                        if (converted.tool_calls) {
                            if (!lastMessage.tool_calls) {
                                lastMessage.tool_calls = [];
                            }
                            lastMessage.tool_calls.push(...converted.tool_calls);
                        }

                        // Merge reasoning tokens
                        if (converted.reasoning != null) {
                            if (!lastMessage.reasoning) {
                                lastMessage.reasoning = converted.reasoning;
                            } else {
                                lastMessage.reasoning += converted.reasoning;
                            }
                        }
                        if (converted.reasoning_content != null) {
                            if (!lastMessage.reasoning_content) {
                                lastMessage.reasoning_content =
                                    converted.reasoning_content;
                            } else {
                                lastMessage.reasoning_content +=
                                    converted.reasoning_content;
                            }
                        }

                        // Merge reasoning details
                        if (converted.reasoning_details) {
                            if (!lastMessage.reasoning_details) {
                                lastMessage.reasoning_details = [];
                            }
                            lastMessage.reasoning_details.push(
                                ...(Array.isArray(converted.reasoning_details)
                                    ? converted.reasoning_details
                                    : [converted.reasoning_details]),
                            );
                        }
                        continue;
                    }

                    if (converted.role === 'user') {
                        // Merge content
                        if (converted.content != null) {
                            if (lastMessage.content == null) {
                                lastMessage.content = converted.content;
                            } else {
                                lastMessage.content =
                                    String(lastMessage.content) +
                                    '\n' +
                                    String(converted.content);
                            }
                        }
                        continue;
                    }
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
        addCacheControlToLastToolMessage(messages);
    }

    return messages;
}

export function extractFunctionToolsFromRequest(req: ModelRequest): any[] {
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

export function extractModelSettingsForRequest(settings: any): any {
    const body: any = {};

    if (settings) {
        // Temperature: Supported by both SDK and OpenRouter
        if (settings.temperature != null)
            body.temperature = settings.temperature;

        // Top P: Supported by both (SDK uses topP, OpenRouter uses top_p)
        if (settings.topP != null) body.top_p = settings.topP;

        // Max Tokens: Supported by both (SDK uses maxTokens, OpenRouter uses max_tokens)
        if (settings.maxTokens != null) body.max_tokens = settings.maxTokens;

        // Top K: Supported by some models via OpenRouter
        if (settings.topK != null) body.top_k = settings.topK;

        // Frequency Penalty: OpenAI standard parameter
        if (settings.frequencyPenalty != null)
            body.frequency_penalty = settings.frequencyPenalty;

        // Presence Penalty: OpenAI standard parameter
        if (settings.presencePenalty != null)
            body.presence_penalty = settings.presencePenalty;

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
    }

    return body;
}
