export class OpenRouterDecisionError extends Error {
    code;
    status;
    constructor(message, code, metadata = {}) {
        super(message);
        this.name = 'OpenRouterDecisionError';
        this.code = code;
        this.status = metadata.status;
    }
}
export async function requestOpenRouterDecisions({ model, state, questions, apiKey, baseUrl = 'https://openrouter.ai/api/v1', fetchImpl = fetch, timeoutMs = 10_000, }) {
    if (!apiKey) {
        throw new OpenRouterDecisionError('OpenRouter Decisions requires an API key', 'configuration_error');
    }
    let endpoint;
    try {
        endpoint = new URL(baseUrl);
    }
    catch {
        throw new OpenRouterDecisionError('OpenRouter Decisions base URL is invalid', 'configuration_error');
    }
    const basePath = endpoint.pathname.replace(/\/+$/, '');
    endpoint.pathname = `${basePath.replace(/\/api\/v1$/, '')}/api/alpha/decisions`;
    const url = endpoint.toString();
    let body;
    try {
        body = JSON.stringify({ model, state, questions });
    }
    catch {
        throw new OpenRouterDecisionError('OpenRouter Decisions request could not be serialized', 'request_serialization');
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('OpenRouter Decisions shadow deadline exceeded')), timeoutMs);
    try {
        let response;
        try {
            response = await fetchImpl(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body,
                signal: controller.signal,
            });
        }
        catch {
            if (controller.signal.aborted) {
                throw new OpenRouterDecisionError('OpenRouter Decisions shadow deadline exceeded', 'timeout');
            }
            throw new OpenRouterDecisionError('OpenRouter Decisions request failed', 'network_error');
        }
        if (!response.ok) {
            throw new OpenRouterDecisionError(`OpenRouter Decisions returned HTTP ${response.status}`, 'http_error', {
                status: response.status,
            });
        }
        try {
            return await response.json();
        }
        catch (error) {
            if (controller.signal.aborted) {
                throw new OpenRouterDecisionError('OpenRouter Decisions shadow deadline exceeded', 'timeout');
            }
            if (error instanceof SyntaxError) {
                throw new OpenRouterDecisionError('OpenRouter Decisions returned invalid JSON', 'invalid_json');
            }
            throw new OpenRouterDecisionError('OpenRouter Decisions response could not be read', 'response_read_error');
        }
    }
    finally {
        clearTimeout(deadline);
    }
}
//# sourceMappingURL=openrouter-decisions.js.map