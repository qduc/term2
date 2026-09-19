import type { ILoggingService } from '../service-interfaces.js';
import { snapshotCallableToolCatalog } from './callable-tool-catalog.js';
import { readDecisionErrorMetadata, type DecisionClient } from './decision-client.js';
import type {
  DecisionShadowObserver,
  TerminalFailureObservation,
  ToolSelectionOutcomeObservation,
  ToolSelectionRequestObservation,
} from './decision-shadow-observer.js';
import { evaluateFailureTriage } from './failure-triage.js';
import { FAILURE_TRIAGE_PROMPT_VERSION } from './failure-triage.js';
import {
  evaluateToolSelection,
  TOOL_SELECTION_PROMPT_VERSION,
  type ToolSelectionEvidence,
  type ToolSelectionPrediction,
} from './tool-selection.js';

const MAX_ACTIVE_OBSERVATIONS = 4;

type PendingToolSelection = {
  readonly requestedModel: string;
  readonly startedAt: number;
  latencyMs?: number;
  prediction?: ToolSelectionPrediction;
  failure?: DecisionFailureTelemetry;
  outcome?: ToolSelectionOutcomeObservation;
};

type DecisionFailureTelemetry = {
  readonly latencyMs: number;
  readonly resolvedModel?: string;
  readonly costUsdMicros?: number;
  readonly errorType: string;
  readonly errorCode?: string;
};

type ObservationKind = 'tool_selection' | 'failure_triage';

export class DecisionShadowPilot implements DecisionShadowObserver {
  readonly #client: DecisionClient;
  readonly #resolveModel: () => string | undefined;
  readonly #logger: ILoggingService;
  readonly #now: () => number;
  readonly #pendingTools = new Map<string, PendingToolSelection>();
  #active = 0;

  constructor(options: {
    client: DecisionClient;
    resolveModel: () => string | undefined;
    logger: ILoggingService;
    now?: () => number;
  }) {
    this.#client = options.client;
    this.#resolveModel = options.resolveModel;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => performance.now());
  }

  observeToolSelectionRequest(observation: ToolSelectionRequestObservation): void {
    const requestedModel = this.#configuredModel();
    if (!requestedModel) return;
    if (!this.#hasCapacity('tool_selection', observation.requestId, true)) return;
    const snapshotStartedAt = this.#now();
    let evidence: ToolSelectionEvidence;
    try {
      evidence = {
        ...observation,
        input: structuredClone(observation.input),
        tools: structuredClone(snapshotCallableToolCatalog(observation.tools)),
      };
    } catch (error) {
      this.#log('warn', 'Decision shadow observation failed', {
        eventType: 'decision_shadow.failed',
        kind: 'tool_selection',
        requestId: observation.requestId,
        promptVersion: TOOL_SELECTION_PROMPT_VERSION,
        requestedModel,
        resolvedModel: 'unknown',
        latencyMs: Math.max(0, this.#now() - snapshotStartedAt),
        cost: 'unknown',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return;
    }
    const startedAt = this.#now();
    const pending: PendingToolSelection = { requestedModel, startedAt };
    this.#pendingTools.set(observation.requestId, pending);
    const admitted = this.#start({
      kind: 'tool_selection',
      requestId: observation.requestId,
      requestedModel,
      promptVersion: TOOL_SELECTION_PROMPT_VERSION,
      startedAt,
      operation: async () => {
        pending.prediction = await evaluateToolSelection(this.#client, requestedModel, evidence);
        pending.latencyMs = Math.max(0, this.#now() - pending.startedAt);
        this.#flushToolSelection(observation.requestId);
      },
      onFailure: (failure) => {
        pending.failure = failure;
        this.#flushToolSelection(observation.requestId);
      },
    });
    if (!admitted) this.#pendingTools.delete(observation.requestId);
  }

  observeToolSelectionOutcome(observation: ToolSelectionOutcomeObservation): void {
    const pending = this.#pendingTools.get(observation.requestId);
    if (!pending) return;
    pending.outcome = structuredClone(observation);
    this.#flushToolSelection(observation.requestId);
  }

  observeTerminalFailure(observation: TerminalFailureObservation): void {
    const requestedModel = this.#configuredModel();
    if (!requestedModel) return;
    if (observation.comparison.cancelled) {
      this.#log('debug', 'Decision shadow observation skipped', {
        eventType: 'decision_shadow.skipped',
        kind: 'failure_triage',
        requestId: observation.evidence.requestId,
        reason: 'cancelled',
      });
      return;
    }
    if (!this.#hasCapacity('failure_triage', observation.evidence.requestId, false)) return;
    const snapshotStartedAt = this.#now();
    let snapshot: TerminalFailureObservation;
    try {
      snapshot = structuredClone(observation);
    } catch (error) {
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
      kind: 'failure_triage',
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

  #configuredModel(): string | undefined {
    try {
      const model = this.#resolveModel()?.trim();
      return model || undefined;
    } catch {
      return undefined;
    }
  }

  #hasCapacity(kind: ObservationKind, requestId: string, includePendingTools: boolean): boolean {
    if (
      this.#active < MAX_ACTIVE_OBSERVATIONS &&
      (!includePendingTools || this.#pendingTools.size < MAX_ACTIVE_OBSERVATIONS)
    ) {
      return true;
    }
    this.#log('debug', 'Decision shadow observation skipped', {
      eventType: 'decision_shadow.skipped',
      kind,
      requestId,
      reason: 'capacity',
      active: this.#active,
      limit: MAX_ACTIVE_OBSERVATIONS,
    });
    return false;
  }

  #start(options: {
    kind: ObservationKind;
    requestId: string;
    requestedModel: string;
    promptVersion: string;
    operation: () => Promise<void>;
    onFailure?: (failure: DecisionFailureTelemetry) => void;
    startedAt?: number;
  }): boolean {
    if (this.#active >= MAX_ACTIVE_OBSERVATIONS) {
      this.#log('debug', 'Decision shadow observation skipped', {
        eventType: 'decision_shadow.skipped',
        kind: options.kind,
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
      kind: options.kind,
      requestId: options.requestId,
      requestedModel: options.requestedModel,
      promptVersion: options.promptVersion,
    });
    void Promise.resolve()
      .then(options.operation)
      .catch((error) => {
        const metadata = readDecisionErrorMetadata(error);
        const failure: DecisionFailureTelemetry = {
          latencyMs: Math.max(0, this.#now() - startedAt),
          ...(metadata.resolvedModel ? { resolvedModel: metadata.resolvedModel } : {}),
          ...(metadata.costUsdMicros !== undefined ? { costUsdMicros: metadata.costUsdMicros } : {}),
          errorType: metadata.errorType,
          ...(metadata.errorCode ? { errorCode: metadata.errorCode } : {}),
        };
        this.#log('warn', 'Decision shadow observation failed', {
          eventType: 'decision_shadow.failed',
          kind: options.kind,
          requestId: options.requestId,
          promptVersion: options.promptVersion,
          requestedModel: options.requestedModel,
          resolvedModel: failure.resolvedModel ?? 'unknown',
          latencyMs: failure.latencyMs,
          cost: failure.costUsdMicros ?? 'unknown',
          errorType: failure.errorType,
          ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
        });
        options.onFailure?.(failure);
      })
      .finally(() => {
        this.#active--;
      });
    return true;
  }

  #flushToolSelection(requestId: string): void {
    const pending = this.#pendingTools.get(requestId);
    if (!pending?.outcome || (!pending.prediction && !pending.failure)) return;
    this.#pendingTools.delete(requestId);
    if (pending.failure) {
      this.#log('info', 'Decision shadow tool-selection comparison', {
        eventType: 'decision_shadow.tool_selection',
        promptVersion: TOOL_SELECTION_PROMPT_VERSION,
        requestId,
        requestedModel: pending.requestedModel,
        resolvedModel: pending.failure.resolvedModel ?? 'unknown',
        latencyMs: pending.failure.latencyMs,
        cost: pending.failure.costUsdMicros ?? 'unknown',
        predictionStatus: 'invalid',
        errorType: pending.failure.errorType,
        ...(pending.failure.errorCode ? { errorCode: pending.failure.errorCode } : {}),
        observedOutcome: pending.outcome.outcome,
        observedSelections: pending.outcome.selections,
      });
      return;
    }
    const prediction = pending.prediction;
    if (!prediction) return;
    this.#log('info', 'Decision shadow tool-selection comparison', {
      eventType: 'decision_shadow.tool_selection',
      promptVersion: TOOL_SELECTION_PROMPT_VERSION,
      requestId,
      requestedModel: pending.requestedModel,
      resolvedModel: prediction.resolvedModel,
      latencyMs: pending.latencyMs,
      cost: prediction.costUsdMicros ?? 'unknown',
      predictionStatus: 'valid',
      predictedToolId: prediction.selectedToolId,
      confidence: prediction.confidence,
      observedOutcome: pending.outcome.outcome,
      observedSelections: pending.outcome.selections,
    });
  }

  #log(method: 'info' | 'warn' | 'debug', message: string, meta: Record<string, unknown>): void {
    try {
      this.#logger[method](message, meta);
    } catch {
      // Optional observation must remain invisible to foreground execution.
    }
  }
}
