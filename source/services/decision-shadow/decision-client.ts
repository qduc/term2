import {
  OpenRouterDecisionError,
  requestOpenRouterDecisions,
  type DecisionQuestion,
  type OpenRouterDecisionErrorCode,
} from '../../providers/openrouter-decisions.js';
import { parseUsdMicros } from '../cost/model-cost.js';

export type DecisionClientRequest = {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Record<string, DecisionQuestion>;
};

export type DecisionClientResponse = {
  readonly answers: Record<string, unknown>;
  readonly resolvedModel?: string;
  readonly costUsdMicros?: number;
};

export type DecisionEvaluationErrorCode = 'invalid_response' | 'invalid_choice';

export class DecisionEvaluationError extends Error {
  readonly code: DecisionEvaluationErrorCode;
  readonly resolvedModel?: string;
  readonly costUsdMicros?: number;

  constructor(
    message: string,
    code: DecisionEvaluationErrorCode,
    metadata: Pick<DecisionClientResponse, 'resolvedModel' | 'costUsdMicros'> = {},
  ) {
    super(message);
    this.name = 'DecisionEvaluationError';
    this.code = code;
    this.resolvedModel = metadata.resolvedModel;
    this.costUsdMicros = metadata.costUsdMicros;
  }
}

export interface DecisionClient {
  decide(request: DecisionClientRequest): Promise<DecisionClientResponse>;
}

export function createOpenRouterDecisionClient(options: {
  resolveTransport: () => { apiKey: string; baseUrl?: string };
  fetchImpl?: typeof fetch;
}): DecisionClient {
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

function normalizeDecisionResponse(response: unknown): DecisionClientResponse {
  if (!isRecord(response)) {
    throw new DecisionEvaluationError('OpenRouter Decisions response has invalid answers', 'invalid_response');
  }
  const metadata = readDecisionResponseMetadata(response);
  if (!isRecord(response.answers)) {
    throw new DecisionEvaluationError(
      'OpenRouter Decisions response has invalid answers',
      'invalid_response',
      metadata,
    );
  }
  return {
    answers: response.answers,
    ...metadata,
  };
}

export function withDecisionResponseMetadata(
  error: unknown,
  code: DecisionEvaluationErrorCode,
  response: Pick<DecisionClientResponse, 'resolvedModel' | 'costUsdMicros'>,
): DecisionEvaluationError {
  if (error instanceof DecisionEvaluationError) return error;
  return new DecisionEvaluationError(
    error instanceof Error ? error.message : 'Invalid decision response',
    code,
    response,
  );
}

export function readDecisionErrorMetadata(error: unknown): {
  readonly resolvedModel?: string;
  readonly costUsdMicros?: number;
  readonly errorType: string;
  readonly errorCode?: DecisionEvaluationErrorCode | OpenRouterDecisionErrorCode;
  readonly httpStatus?: number;
} {
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

export function readDecisionChoice<T extends string>(
  answers: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): { choice: T; confidence: number } {
  const answer = answers[key];
  if (!isRecord(answer) || answer.type !== 'choice' || !allowed.includes(answer.choice as T)) {
    throw new Error(`Invalid decision answer ${key}`);
  }
  if (
    typeof answer.confidence !== 'number' ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < 0 ||
    answer.confidence > 1
  ) {
    throw new Error(`Invalid decision confidence ${key}`);
  }
  return { choice: answer.choice as T, confidence: answer.confidence };
}

const readCost = (response: Record<string, unknown>): number | string | undefined => {
  if (typeof response.cost === 'number' || typeof response.cost === 'string') return response.cost;
  const usage = response.usage;
  if (!isRecord(usage)) return undefined;
  return typeof usage.cost === 'number' || typeof usage.cost === 'string' ? usage.cost : undefined;
};

const readDecisionResponseMetadata = (
  response: Record<string, unknown>,
): Pick<DecisionClientResponse, 'resolvedModel' | 'costUsdMicros'> => {
  const costUsdMicros = parseUsdMicros(readCost(response));
  return {
    ...(typeof response.model === 'string' && response.model ? { resolvedModel: response.model } : {}),
    ...(costUsdMicros !== undefined ? { costUsdMicros } : {}),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
