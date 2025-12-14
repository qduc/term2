import type {ISettingsService} from '../../services/service-interfaces.js';
import {getOpenRouterBaseUrl} from './utils.js';
import {extractModelSettingsForRequest} from './converters.js';

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

export async function callOpenRouter({
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
