import {
    type ModelProvider,
    type Model,
    type ModelRequest,
    type ModelResponse,
    type ResponseStreamEvent,
} from '@openai/agents-core';

// Minimal OpenRouter Chat Completions client implementing the Agents Core Model interface.

const OPENROUTER_BASE_URL =
    process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

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
            'HTTP-Referer': process.env.OPENROUTER_REFERRER || 'http://localhost',
            'X-Title': process.env.OPENROUTER_TITLE || 'term2',
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
            modelId || process.env.OPENROUTER_MODEL || 'openrouter/auto';
    }

    async getResponse(request: ModelRequest): Promise<ModelResponse> {
        const apiKey = process.env.OPENROUTER_API_KEY;
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
        const response: ModelResponse = {
            usage,
            output: [
                {
                    type: 'message',
                    role: 'assistant',
                    content,
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
        const apiKey = process.env.OPENROUTER_API_KEY;
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
        if (!reader) {
            // Fallback to non-stream
            const full = await this.getResponse(request);
            yield {type: 'response.completed', response: full} as any;
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
                        const full: ModelResponse = {
                            usage: {},
                            output: [
                                {
                                    type: 'message',
                                    role: 'assistant',
                                    content: accumulated,
                                } as any,
                            ],
                        } as any;
                        yield {type: 'response.completed', response: full} as any;
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        const delta =
                            json?.choices?.[0]?.delta?.content ?? '';
                        if (delta) {
                            accumulated += delta;
                            // Emit a minimal text delta event
                            yield {
                                type: 'response.output_text.delta',
                                delta,
                            } as any;
                        }
                    } catch {
                        // ignore parse errors for keep-alive lines
                    }
                }
            }
        }
        // End without [DONE]
        const full: ModelResponse = {
            usage: {},
            output: [
                {type: 'message', role: 'assistant', content: accumulated} as any,
            ],
        } as any;
        yield {type: 'response.completed', response: full} as any;
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
