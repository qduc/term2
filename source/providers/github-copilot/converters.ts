import type { ModelRequest } from '@openai/agents-core';
import type { ILoggingService } from '../../services/service-interfaces.js';

/**
 * Content item types from SDK ModelRequest
 */
interface TextContent {
    type: 'input_text';
    text: string;
}

interface ImageContent {
    type: 'input_image';
    image: string;
    detail?: 'auto' | 'low' | 'high';
}

type ContentItem = TextContent | ImageContent | { type: string; [key: string]: unknown };

/**
 * SDK message output types
 */
interface OutputItem {
    type: string;
    role?: string;
    content?: ContentItem[] | string;
    text?: string;
    name?: string;
    callId?: string;
    arguments?: string;
    output?: string;
    reasoning?: string;
    [key: string]: unknown;
}

/**
 * Copilot SDK message format
 */
export interface CopilotMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
            name: string;
            arguments: string;
        };
    }>;
}

/**
 * Extract text from various content item formats
 */
function extractTextFromContent(content: ContentItem[] | string | undefined): string {
    if (!content) return '';

    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map(item => {
                if (item.type === 'input_text' && 'text' in item) {
                    return (item as TextContent).text;
                }
                if (item.type === 'output_text' && 'text' in item) {
                    return (item as { type: string; text: string }).text;
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }

    return '';
}

/**
 * Convert SDK ModelRequest to Copilot SDK message format.
 * Maps the conversation history from the SDK format to what Copilot expects.
 */
export function buildMessagesFromRequest(
    request: ModelRequest,
    modelId: string,
    loggingService: ILoggingService,
): CopilotMessage[] {
    const messages: CopilotMessage[] = [];

    // Add system instructions if present
    if (request.systemInstructions) {
        messages.push({
            role: 'system',
            content: request.systemInstructions,
        });
    }

    // Process input items (conversation history)
    if (request.input && Array.isArray(request.input)) {
        for (const item of request.input) {
            const outputItem = item as OutputItem;

            if (outputItem.type === 'message') {
                const role = outputItem.role as 'user' | 'assistant';
                const content = extractTextFromContent(outputItem.content as ContentItem[] | string);

                if (content) {
                    messages.push({ role, content });
                }
            } else if (outputItem.type === 'function_call') {
                // Tool call made by assistant
                const lastMessage = messages[messages.length - 1];
                const toolCall = {
                    id: outputItem.callId || `call_${Date.now()}`,
                    type: 'function' as const,
                    function: {
                        name: outputItem.name || '',
                        arguments: outputItem.arguments || '{}',
                    },
                };

                if (lastMessage?.role === 'assistant' && lastMessage.tool_calls) {
                    lastMessage.tool_calls.push(toolCall);
                } else {
                    messages.push({
                        role: 'assistant',
                        content: '',
                        tool_calls: [toolCall],
                    });
                }
            } else if (outputItem.type === 'function_call_output') {
                // Tool result
                messages.push({
                    role: 'tool',
                    content: typeof outputItem.output === 'string'
                        ? outputItem.output
                        : JSON.stringify(outputItem.output),
                    tool_call_id: outputItem.callId || '',
                });
            }
        }
    }

    loggingService.debug('GitHubCopilot built messages', {
        messageCount: messages.length,
        modelId,
    });

    return messages;
}

/**
 * Extract function tools from the ModelRequest.
 * Filters out SDK-specific tools and returns only function tools.
 */
export function extractFunctionToolsFromRequest(
    request: ModelRequest,
): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
    if (!request.tools || !Array.isArray(request.tools)) {
        return [];
    }

    return request.tools
        .filter((tool: any) => tool.type === 'function')
        .map((tool: any) => ({
            type: 'function' as const,
            function: {
                name: tool.name,
                description: tool.description || '',
                parameters: tool.parameters || { type: 'object', properties: {} },
            },
        }));
}

/**
 * Normalize usage data to SDK format
 */
export function normalizeUsage(usage: any): {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
} {
    const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? inputTokens + outputTokens;

    return { inputTokens, outputTokens, totalTokens };
}
