import {
    type ModelProvider,
    type Model,
    type ModelRequest,
    type ModelResponse,
    type ResponseStreamEvent,
} from '@openai/agents-core';
import {settingsService} from '../services/settings-service.js';

// Minimal OpenRouter Chat Completions client implementing the Agents Core Model interface.
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

function buildMessagesFromRequest(req: ModelRequest): any[] {
    const messages: any[] = [];
    if (req.systemInstructions && req.systemInstructions.trim().length > 0) {
        messages.push({role: 'system', content: req.systemInstructions});
    }

    // Support only simple text input for now; if array, join text parts.
    if (typeof req.input === 'string') {
        messages.push({role: 'user', content: req.input});
    } else if (Array.isArray(req.input)) {
        const textParts: string[] = [];
        for (const item of req.input as any[]) {
            // best effort: handle text items
            if (item?.type === 'input_text' && typeof item?.text === 'string') {
                textParts.push(item.text);
            }
        }
        if (textParts.length > 0) {
            messages.push({role: 'user', content: textParts.join('\n')});
        }
    }
    return messages;
}

async function callOpenRouter({
    apiKey,
    model,
    messages,
    stream,
    signal,
    settings,
}: {
    apiKey: string;
    model: string;
    messages: any[];
    stream: boolean;
    signal?: AbortSignal;
    settings?: any;
}): Promise<Response> {
    const url = `${OPENROUTER_BASE_URL}/chat/completions`;
    const body: any = {
        model,
        messages,
        stream,
    };
    if (settings) {
        if (settings.temperature != null) body.temperature = settings.temperature;
        if (settings.topP != null) body.top_p = settings.topP;
        if (settings.maxTokens != null) body.max_tokens = settings.maxTokens;
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
        const messages = buildMessagesFromRequest(request);
        const res = await callOpenRouter({
            apiKey,
            model: this.#resolveModelFromRequest(request) || this.#modelId,
            messages,
            stream: false,
            signal: request.signal,
            settings: request.modelSettings,
        });
        const json: any = await res.json();
        const choice = json?.choices?.[0];
        const content = choice?.message?.content ?? '';

        const usage = json?.usage || {};
        // IMPORTANT: The Agents SDK expects a specific structure for ModelResponse.output:
        // - Each item must be an AssistantMessageItem with:
        //   - type: 'message' (optional but recommended)
        //   - role: 'assistant'
        //   - status: 'completed' | 'in_progress' | 'incomplete' (REQUIRED)
        //   - content: ARRAY of content objects (NOT a plain string)
        // - Content objects must have:
        //   - type: 'output_text'
        //   - text: the actual string content
        // Failing to include 'status' or using plain strings for 'content' will cause
        // "Model did not produce a final response" errors.
        const response: ModelResponse = {
            usage,
            output: [
                {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                        {
                            type: 'output_text',
                            text: content,
                        },
                    ],
                } as any,
            ],
            responseId: json?.id,
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
        const messages = buildMessagesFromRequest(request);
        const res = await callOpenRouter({
            apiKey,
            model: this.#resolveModelFromRequest(request) || this.#modelId,
            messages,
            stream: true,
            signal: request.signal,
            settings: request.modelSettings,
        });

        // OpenRouter streaming returns SSE with lines starting with "data: {...}"
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';
        let responseId = 'unknown'; // Will be updated from stream chunks
        let usageData: any = null; // Will be updated if usage info is in stream
        if (!reader) {
            // Fallback to non-stream - call getResponse which handles ModelResponse format,
            // but we need to wrap it in the correct response_done event format
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
                        // See comment above getResponse() for explanation of this structure.
                        // For streaming responses, the final ModelResponse must follow the same
                        // format with status: 'completed' and content as an array.
                        // IMPORTANT: The stream event type must be 'response_done' (not 'response.completed')
                        // IMPORTANT: The response_done event REQUIRES:
                        //   - response.id (string)
                        //   - response.usage.inputTokens (number)
                        //   - response.usage.outputTokens (number)
                        //   - response.usage.totalTokens (number)
                        yield {
                            type: 'response_done',
                            response: {
                                id: responseId,
                                usage: normalizeUsage(usageData),
                                output: [
                                    {
                                        type: 'message',
                                        role: 'assistant',
                                        status: 'completed',
                                        content: [
                                            {
                                                type: 'output_text',
                                                text: accumulated,
                                            },
                                        ],
                                    } as any,
                                ],
                            },
                        } as any;
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        // Capture response ID from first chunk
                        if (json?.id && responseId === 'unknown') {
                            responseId = json.id;
                        }
                        // Capture usage data if present (some providers send it in final chunk)
                        if (json?.usage) {
                            usageData = json.usage;
                        }
                        const delta =
                            json?.choices?.[0]?.delta?.content ?? '';
                        if (delta) {
                            accumulated += delta;
                            // Emit a text delta event
                            // IMPORTANT: The event type must be 'output_text_delta' (not 'response.output_text.delta')
                            yield {
                                type: 'output_text_delta',
                                delta,
                            } as any;
                        }
                    } catch {
                        // ignore parse errors for keep-alive lines
                    }
                }
            }
        }
        // End without [DONE] - same structure required as above
        yield {
            type: 'response_done',
            response: {
                id: responseId,
                usage: normalizeUsage(usageData),
                output: [
                    {
                        type: 'message',
                        role: 'assistant',
                        status: 'completed',
                        content: [
                            {
                                type: 'output_text',
                                text: accumulated,
                            },
                        ],
                    } as any,
                ],
            },
        } as any;
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

export {OpenRouterModel, OpenRouterProvider};
