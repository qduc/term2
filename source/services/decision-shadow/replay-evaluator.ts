import { readDecisionErrorMetadata, type DecisionClient } from './decision-client.js';
import { evaluateFailureTriage, FAILURE_TRIAGE_PROMPT_VERSION } from './failure-triage.js';
import type { FailureTriageReplayFixture, ToolSelectionReplayFixture } from './replay-fixtures.js';
import { evaluateToolSelection, TOOL_SELECTION_PROMPT_VERSION } from './tool-selection.js';

type ReplayError = { readonly name: string; readonly code?: string; readonly httpStatus?: number };

export type ReplayCaseResult =
  | {
      readonly fixtureId: string;
      readonly kind: 'tool_selection';
      readonly promptVersion: typeof TOOL_SELECTION_PROMPT_VERSION;
      readonly requestedModel: string;
      readonly resolvedModel: string;
      readonly latencyMs: number;
      readonly cost: number | 'unknown';
      readonly expected: { readonly selectedToolId: string };
      readonly prediction?: { readonly selectedToolId: string; readonly confidence: number };
      readonly error?: ReplayError;
      readonly correct: boolean;
    }
  | {
      readonly fixtureId: string;
      readonly kind: 'failure_triage';
      readonly promptVersion: typeof FAILURE_TRIAGE_PROMPT_VERSION;
      readonly requestedModel: string;
      readonly resolvedModel: string;
      readonly latencyMs: number;
      readonly cost: number | 'unknown';
      readonly expected: { readonly category: string; readonly retry: string };
      readonly prediction?: { readonly category: string; readonly retry: string; readonly confidence: number };
      readonly error?: ReplayError;
      readonly correct: boolean;
    };

export async function evaluateReplayFixtures(input: {
  client: DecisionClient;
  model: string;
  toolSelection: readonly ToolSelectionReplayFixture[];
  failureTriage: readonly FailureTriageReplayFixture[];
  now?: () => number;
}): Promise<{
  total: number;
  correct: number;
  errors?: Array<{ fixtureId: string; error: string }>;
  cases: ReplayCaseResult[];
}> {
  let correct = 0;
  const errors: Array<{ fixtureId: string; error: string }> = [];
  const cases: ReplayCaseResult[] = [];
  const now = input.now ?? (() => performance.now());
  for (const fixture of input.toolSelection) {
    const startedAt = now();
    try {
      const prediction = await evaluateToolSelection(input.client, input.model, fixture.evidence);
      const isCorrect = prediction.selectedToolId === fixture.expectedToolId;
      if (isCorrect) correct++;
      cases.push({
        fixtureId: fixture.id,
        kind: 'tool_selection',
        promptVersion: TOOL_SELECTION_PROMPT_VERSION,
        requestedModel: input.model,
        resolvedModel: prediction.resolvedModel ?? 'unknown',
        latencyMs: Math.max(0, now() - startedAt),
        cost: prediction.costUsdMicros ?? 'unknown',
        expected: { selectedToolId: fixture.expectedToolId ?? 'none' },
        prediction: { selectedToolId: prediction.selectedToolId ?? 'none', confidence: prediction.confidence },
        correct: isCorrect,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const metadata = readDecisionErrorMetadata(error);
      errors.push({ fixtureId: fixture.id, error: message });
      cases.push({
        fixtureId: fixture.id,
        kind: 'tool_selection',
        promptVersion: TOOL_SELECTION_PROMPT_VERSION,
        requestedModel: input.model,
        resolvedModel: metadata.resolvedModel ?? 'unknown',
        latencyMs: Math.max(0, now() - startedAt),
        cost: metadata.costUsdMicros ?? 'unknown',
        expected: { selectedToolId: fixture.expectedToolId ?? 'none' },
        error: {
          name: metadata.errorType,
          ...(metadata.errorCode ? { code: metadata.errorCode } : {}),
          ...(metadata.httpStatus !== undefined ? { httpStatus: metadata.httpStatus } : {}),
        },
        correct: false,
      });
    }
  }
  for (const fixture of input.failureTriage) {
    const startedAt = now();
    try {
      const prediction = await evaluateFailureTriage({
        client: input.client,
        model: input.model,
        evidence: fixture.evidence,
      });
      const isCorrect =
        prediction.category === fixture.expected.category && prediction.retry === fixture.expected.retry;
      if (isCorrect) correct++;
      cases.push({
        fixtureId: fixture.id,
        kind: 'failure_triage',
        promptVersion: FAILURE_TRIAGE_PROMPT_VERSION,
        requestedModel: input.model,
        resolvedModel: prediction.resolvedModel ?? 'unknown',
        latencyMs: Math.max(0, now() - startedAt),
        cost: prediction.costUsdMicros ?? 'unknown',
        expected: fixture.expected,
        prediction: {
          category: prediction.category,
          retry: prediction.retry,
          confidence: prediction.confidence,
        },
        correct: isCorrect,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const metadata = readDecisionErrorMetadata(error);
      errors.push({ fixtureId: fixture.id, error: message });
      cases.push({
        fixtureId: fixture.id,
        kind: 'failure_triage',
        promptVersion: FAILURE_TRIAGE_PROMPT_VERSION,
        requestedModel: input.model,
        resolvedModel: metadata.resolvedModel ?? 'unknown',
        latencyMs: Math.max(0, now() - startedAt),
        cost: metadata.costUsdMicros ?? 'unknown',
        expected: fixture.expected,
        error: {
          name: metadata.errorType,
          ...(metadata.errorCode ? { code: metadata.errorCode } : {}),
          ...(metadata.httpStatus !== undefined ? { httpStatus: metadata.httpStatus } : {}),
        },
        correct: false,
      });
    }
  }
  return {
    total: input.toolSelection.length + input.failureTriage.length,
    correct,
    ...(errors.length ? { errors } : {}),
    cases,
  };
}
