import { OpenRouterDecisionError, requestOpenRouterDecisions, } from '../../providers/openrouter-decisions.js';
import { parseUsdMicros } from '../cost/model-cost.js';
export class DecisionEvaluationError extends Error {
    code;
    resolvedModel;
    costUsdMicros;
    constructor(message, code, metadata = {}) {
        super(message);
        this.name = 'DecisionEvaluationError';
        this.code = code;
        this.resolvedModel = metadata.resolvedModel;
        this.costUsdMicros = metadata.costUsdMicros;
    }
}
export function createOpenRouterDecisionClient(options) {
    return {
        async decide(request) {
            const transport = options.resolveTransport();
            const response = await requestOpenRouterDecisions({
                ...request,
                apiKey: transport.apiKey,
                ...(transport.baseUrl ? { baseUrl: transport.baseUrl } : {}),
                ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            });
            return normalizeDecisionResponse(response);
        },
    };
}
function normalizeDecisionResponse(response) {
    if (!isRecord(response)) {
        throw new DecisionEvaluationError('OpenRouter Decisions response has invalid answers', 'invalid_response');
    }
    const metadata = readDecisionResponseMetadata(response);
    if (!isRecord(response.answers)) {
        throw new DecisionEvaluationError('OpenRouter Decisions response has invalid answers', 'invalid_response', metadata);
    }
    return {
        answers: response.answers,
        ...metadata,
    };
}
export function withDecisionResponseMetadata(error, code, response) {
    if (error instanceof DecisionEvaluationError)
        return error;
    return new DecisionEvaluationError(error instanceof Error ? error.message : 'Invalid decision response', code, response);
}
export function readDecisionErrorMetadata(error) {
    if (error instanceof DecisionEvaluationError) {
        return {
            ...(error.resolvedModel ? { resolvedModel: error.resolvedModel } : {}),
            ...(error.costUsdMicros !== undefined ? { costUsdMicros: error.costUsdMicros } : {}),
            errorType: error.name,
            errorCode: error.code,
        };
    }
    if (error instanceof OpenRouterDecisionError) {
        return {
            errorType: error.name,
            errorCode: error.code,
            ...(error.status !== undefined ? { httpStatus: error.status } : {}),
        };
    }
    return { errorType: error instanceof Error ? error.name : 'UnknownError' };
}
export function readDecisionChoice(answers, key, allowed) {
    const answer = answers[key];
    if (!isRecord(answer) || answer.type !== 'choice' || !allowed.includes(answer.choice)) {
        throw new Error(`Invalid decision answer ${key}`);
    }
    if (typeof answer.confidence !== 'number' ||
        !Number.isFinite(answer.confidence) ||
        answer.confidence < 0 ||
        answer.confidence > 1) {
        throw new Error(`Invalid decision confidence ${key}`);
    }
    return { choice: answer.choice, confidence: answer.confidence };
}
const readCost = (response) => {
    if (typeof response.cost === 'number' || typeof response.cost === 'string')
        return response.cost;
    const usage = response.usage;
    if (!isRecord(usage))
        return undefined;
    return typeof usage.cost === 'number' || typeof usage.cost === 'string' ? usage.cost : undefined;
};
const readDecisionResponseMetadata = (response) => {
    const costUsdMicros = parseUsdMicros(readCost(response));
    return {
        ...(typeof response.model === 'string' && response.model ? { resolvedModel: response.model } : {}),
        ...(costUsdMicros !== undefined ? { costUsdMicros } : {}),
    };
};
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
//# sourceMappingURL=decision-client.js.map