import {extractModelSettingsForRequest} from '../openrouter/converters.js';
import {buildOpenAICompatibleUrl} from './utils.js';

export class OpenAICompatibleError extends Error {
    status: number;
    headers: Record<string, string>;
    responseBody?: string;

    constructor(
        message: string,
        status: number,
        headers: Record<string, string>,
        responseBody?: string,
    ) {
        super(message);
        this.name = 'OpenAICompatibleError';
        this.status = status;
        this.headers = headers;
        this.responseBody = responseBody;
    }
}

export async function callOpenAICompatibleChatCompletions({
    baseUrl,
    apiKey,
    model,
    messages,
    stream,
    signal,
    settings,
    tools,
}: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    messages: any[];
    stream: boolean;
    signal?: AbortSignal;
    settings?: any;
    tools?: any[];
}): Promise<Response> {
    const url = buildOpenAICompatibleUrl(baseUrl, '/v1/chat/completions');

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
        body.tool_choice = 'auto';
    }

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
    });

    if (!res.ok) {
        let errText: any;
        try {
            errText = await res.text();
        } catch {}

        const headersLower: Record<string, string> = {};
        res.headers.forEach((value, key) => {
            headersLower[key.toLowerCase()] = value;
        });

        const message = `OpenAI-compatible request failed: ${res.status} ${res.statusText}${
            errText ? ` - ${errText}` : ''
        }`;
        throw new OpenAICompatibleError(message, res.status, headersLower, errText);
    }

    return res;
}
