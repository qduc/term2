import { readDecisionErrorMetadata } from './decision-client.js';
import { evaluateFailureTriage } from './failure-triage.js';
import { FAILURE_TRIAGE_PROMPT_VERSION } from './failure-triage.js';
const MAX_ACTIVE_OBSERVATIONS = 4;
export class DecisionShadowPilot {
    #client;
    #resolveModel;
    #logger;
    #now;
    #active = 0;
    constructor(options) {
        this.#client = options.client;
        this.#resolveModel = options.resolveModel;
        this.#logger = options.logger;
        this.#now = options.now ?? (() => performance.now());
    }
    observeTerminalFailure(observation) {
        const requestedModel = this.#configuredModel();
        if (!requestedModel)
            return;
        if (observation.comparison.cancelled) {
            this.#log('debug', 'Decision shadow observation skipped', {
                eventType: 'decision_shadow.skipped',
                kind: 'failure_triage',
                requestId: observation.evidence.requestId,
                reason: 'cancelled',
            });
            return;
        }
        if (!this.#hasCapacity(observation.evidence.requestId))
            return;
        const snapshotStartedAt = this.#now();
        let snapshot;
        try {
            snapshot = structuredClone(observation);
        }
        catch (error) {
            this.#log('warn', 'Decision shadow observation failed', {
                eventType: 'decision_shadow.failed',
                kind: 'failure_triage',
                requestId: observation.evidence.requestId,
                promptVersion: FAILURE_TRIAGE_PROMPT_VERSION,
                requestedModel,
                resolvedModel: 'unknown',
                latencyMs: Math.max(0, this.#now() - snapshotStartedAt),
                cost: 'unknown',
                errorType: error instanceof Error ? error.name : 'UnknownError',
            });
            return;
        }
        const startedAt = this.#now();
        this.#start({
            requestId: snapshot.evidence.requestId,
            requestedModel,
            promptVersion: FAILURE_TRIAGE_PROMPT_VERSION,
            startedAt,
            operation: async () => {
                const prediction = await evaluateFailureTriage({
                    client: this.#client,
                    model: requestedModel,
                    evidence: snapshot.evidence,
                });
                this.#log('info', 'Decision shadow failure-triage comparison', {
                    eventType: 'decision_shadow.failure_triage',
                    promptVersion: FAILURE_TRIAGE_PROMPT_VERSION,
                    requestId: snapshot.evidence.requestId,
                    provider: snapshot.evidence.provider,
                    model: snapshot.evidence.model,
                    requestedModel,
                    resolvedModel: prediction.resolvedModel,
                    latencyMs: Math.max(0, this.#now() - startedAt),
                    cost: prediction.costUsdMicros ?? 'unknown',
                    predictedCategory: prediction.category,
                    predictedRetry: prediction.retry,
                    confidence: prediction.confidence,
                    comparisonErrorKind: snapshot.comparison.errorKind,
                    comparisonRetryable: snapshot.comparison.retryable,
                    observedOutcome: snapshot.comparison.observedOutcome,
                });
            },
        });
    }
    #configuredModel() {
        try {
            const model = this.#resolveModel()?.trim();
            return model || undefined;
        }
        catch {
            return undefined;
        }
    }
    #hasCapacity(requestId) {
        if (this.#active < MAX_ACTIVE_OBSERVATIONS)
            return true;
        this.#log('debug', 'Decision shadow observation skipped', {
            eventType: 'decision_shadow.skipped',
            kind: 'failure_triage',
            requestId,
            reason: 'capacity',
            active: this.#active,
            limit: MAX_ACTIVE_OBSERVATIONS,
        });
        return false;
    }
    #start(options) {
        if (this.#active >= MAX_ACTIVE_OBSERVATIONS) {
            this.#log('debug', 'Decision shadow observation skipped', {
                eventType: 'decision_shadow.skipped',
                kind: 'failure_triage',
                requestId: options.requestId,
                reason: 'capacity',
                active: this.#active,
                limit: MAX_ACTIVE_OBSERVATIONS,
            });
            return false;
        }
        const startedAt = options.startedAt ?? this.#now();
        this.#active++;
        this.#log('info', 'Decision shadow observation started', {
            eventType: 'decision_shadow.started',
            kind: 'failure_triage',
            requestId: options.requestId,
            requestedModel: options.requestedModel,
            promptVersion: options.promptVersion,
        });
        void Promise.resolve()
            .then(options.operation)
            .catch((error) => {
            const metadata = readDecisionErrorMetadata(error);
            const failure = {
                latencyMs: Math.max(0, this.#now() - startedAt),
                ...(metadata.resolvedModel ? { resolvedModel: metadata.resolvedModel } : {}),
                ...(metadata.costUsdMicros !== undefined ? { costUsdMicros: metadata.costUsdMicros } : {}),
                errorType: metadata.errorType,
                ...(metadata.errorCode ? { errorCode: metadata.errorCode } : {}),
                ...(metadata.httpStatus !== undefined ? { httpStatus: metadata.httpStatus } : {}),
            };
            this.#log('warn', 'Decision shadow observation failed', {
                eventType: 'decision_shadow.failed',
                kind: 'failure_triage',
                requestId: options.requestId,
                promptVersion: options.promptVersion,
                requestedModel: options.requestedModel,
                resolvedModel: failure.resolvedModel ?? 'unknown',
                latencyMs: failure.latencyMs,
                cost: failure.costUsdMicros ?? 'unknown',
                errorType: failure.errorType,
                ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
                ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
            });
        })
            .finally(() => {
            this.#active--;
        });
        return true;
    }
    #log(method, message, meta) {
        try {
            this.#logger[method](message, meta);
        }
        catch {
            // Optional observation must remain invisible to foreground execution.
        }
    }
}
//# sourceMappingURL=decision-shadow-pilot.js.map