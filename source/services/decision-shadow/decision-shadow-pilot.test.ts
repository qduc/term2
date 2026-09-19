import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ILoggingService } from '../service-interfaces.js';
import type { DecisionClient } from './decision-client.js';
import { DecisionShadowPilot } from './decision-shadow-pilot.js';

const directTool = {
  name: 'read_file',
  description: 'Read a known file',
  parameters: z.object({ path: z.string() }),
  canRequireApproval: false,
  needsApproval: () => false,
  execute: () => '',
  formatCommandMessage: () => [],
};

const request = (requestId: string) => ({
  requestId,
  provider: 'openrouter',
  model: 'test-model',
  tier: 'standard' as const,
  chaining: false,
  input: [{ type: 'message' as const, role: 'user' as const, content: 'read it' }],
  tools: [directTool],
});

const terminalFailure = (requestId: string) => ({
  evidence: {
    requestId,
    provider: 'openrouter',
    model: 'test-model',
    tier: 'standard' as const,
    status: 503,
    message: 'provider overloaded',
    transport: { errorName: 'ProviderError' },
  },
  comparison: {
    errorKind: 'provider' as const,
    retryable: true,
    cancelled: false,
    observedOutcome: 'run_loop_failed' as const,
  },
});

describe('DecisionShadowPilot', () => {
  it('does not issue a request while the model setting is unset', async () => {
    const decide = vi.fn();
    const pilot = new DecisionShadowPilot({ client: { decide }, resolveModel: () => undefined, logger: logger() });

    expect(pilot.observeToolSelectionRequest(request('req-1'))).toBeUndefined();
    await Promise.resolve();
    expect(decide).not.toHaveBeenCalled();
  });

  it('logs predictions with later comparison labels and explicit unknown cost', async () => {
    const decide = vi.fn(async (_request: Parameters<DecisionClient['decide']>[0]) => ({
      answers: { case: { type: 'choice', choice: 'tool_0', confidence: 0.9 } },
      resolvedModel: 'typesafe/jev-1.13',
    }));
    const testLogger = logger();
    const pilot = new DecisionShadowPilot({
      client: { decide } as DecisionClient,
      resolveModel: () => '~typesafe/jev-latest',
      logger: testLogger,
      now: (() => {
        let now = 100;
        return () => now++;
      })(),
    });

    pilot.observeToolSelectionRequest(request('req-2'));
    expect(testLogger.info).toHaveBeenCalledWith('Decision shadow observation started', {
      eventType: 'decision_shadow.started',
      kind: 'tool_selection',
      requestId: 'req-2',
      requestedModel: '~typesafe/jev-latest',
      promptVersion: 'tool-selection-v2-runtime-catalog',
    });
    pilot.observeToolSelectionOutcome({
      requestId: 'req-2',
      outcome: 'tools',
      selections: [{ name: 'read_file', callPath: 'direct' }],
    });
    await vi.waitFor(() =>
      expect(testLogger.info).toHaveBeenCalledWith(
        'Decision shadow tool-selection comparison',
        expect.objectContaining({ requestId: 'req-2' }),
      ),
    );

    expect(testLogger.info).toHaveBeenCalledWith(
      'Decision shadow tool-selection comparison',
      expect.objectContaining({
        eventType: 'decision_shadow.tool_selection',
        requestedModel: '~typesafe/jev-latest',
        resolvedModel: 'typesafe/jev-1.13',
        cost: 'unknown',
        predictedToolId: 'direct:read_file',
        observedOutcome: 'tools',
        observedSelections: [{ name: 'read_file', callPath: 'direct' }],
      }),
    );
  });

  it('admits at most four simultaneous observations and swallows failures', async () => {
    const pending: Array<() => void> = [];
    const decide = vi.fn(
      (_request: Parameters<DecisionClient['decide']>[0]) =>
        new Promise<never>((_resolve, reject) => {
          pending.push(() => reject(new Error('shadow unavailable')));
        }),
    );
    const testLogger = logger();
    const pilot = new DecisionShadowPilot({
      client: { decide } as DecisionClient,
      resolveModel: () => 'jev',
      logger: testLogger,
    });

    for (let index = 0; index < 5; index++) pilot.observeToolSelectionRequest(request(`req-${index}`));
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(4));
    expect(testLogger.debug).toHaveBeenCalledWith(
      'Decision shadow observation skipped',
      expect.objectContaining({ reason: 'capacity', active: 4 }),
    );
    pending.forEach((reject) => reject());
    await vi.waitFor(() => expect(testLogger.warn).toHaveBeenCalledTimes(4));
  });

  it('checks shared active capacity before cloning terminal-failure evidence', async () => {
    const decide = vi.fn((_request: Parameters<DecisionClient['decide']>[0]) => new Promise<never>(() => undefined));
    const testLogger = logger();
    const pilot = new DecisionShadowPilot({
      client: { decide } as DecisionClient,
      resolveModel: () => 'jev',
      logger: testLogger,
    });
    for (let index = 0; index < 4; index++) pilot.observeToolSelectionRequest(request(`active-${index}`));
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(4));
    const observation = terminalFailure('failure-at-capacity');
    Object.assign(observation.evidence, { transport: new Proxy({}, {}) });

    pilot.observeTerminalFailure(observation);

    expect(testLogger.debug).toHaveBeenCalledWith(
      'Decision shadow observation skipped',
      expect.objectContaining({
        eventType: 'decision_shadow.skipped',
        kind: 'failure_triage',
        requestId: 'failure-at-capacity',
        reason: 'capacity',
      }),
    );
    expect(testLogger.warn).not.toHaveBeenCalled();
  });

  it('freezes request evidence synchronously and records latency when the decision settles', async () => {
    let resolveDecision!: (value: {
      answers: { case: { type: 'choice'; choice: string; confidence: number } };
    }) => void;
    const decide = vi.fn(
      (_request: Parameters<DecisionClient['decide']>[0]) =>
        new Promise<{
          answers: { case: { type: 'choice'; choice: string; confidence: number } };
        }>((resolve) => {
          resolveDecision = resolve;
        }),
    );
    let now = 100;
    const nowFn = vi.fn(() => now);
    const testLogger = logger();
    const pilot = new DecisionShadowPilot({
      client: { decide } as DecisionClient,
      resolveModel: () => 'jev',
      logger: testLogger,
      now: nowFn,
    });
    const mutable = request('req-snapshot');
    pilot.observeToolSelectionRequest(mutable);
    (mutable.input[0] as { content: string }).content = 'mutated after observation';
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(decide.mock.calls[0]![0].state)).toContain('read it');
    expect(JSON.stringify(decide.mock.calls[0]![0].state)).not.toContain('mutated after observation');

    now = 125;
    resolveDecision({ answers: { case: { type: 'choice', choice: 'tool_0', confidence: 1 } } });
    await vi.waitFor(() => expect(nowFn).toHaveBeenCalledTimes(3));
    now = 1000;
    pilot.observeToolSelectionOutcome({
      requestId: 'req-snapshot',
      outcome: 'tools',
      selections: [{ name: 'read_file', callPath: 'direct' }],
    });
    await vi.waitFor(() =>
      expect(testLogger.info).toHaveBeenCalledWith(
        'Decision shadow tool-selection comparison',
        expect.objectContaining({ requestId: 'req-snapshot' }),
      ),
    );
    expect(testLogger.info).toHaveBeenCalledWith(
      'Decision shadow tool-selection comparison',
      expect.objectContaining({ latencyMs: 25, promptVersion: 'tool-selection-v2-runtime-catalog' }),
    );
  });

  it('bounds completed predictions awaiting outcomes and contains throwing loggers', async () => {
    const decide = vi.fn(async () => ({
      answers: { case: { type: 'choice', choice: 'tool_0', confidence: 1 } },
    }));
    const throwingLogger = logger();
    throwingLogger.debug.mockImplementation(() => {
      throw new Error('logger failed');
    });
    throwingLogger.info.mockImplementation(() => {
      throw new Error('logger failed');
    });
    throwingLogger.warn.mockImplementation(() => {
      throw new Error('logger failed');
    });
    const pilot = new DecisionShadowPilot({
      client: { decide } as DecisionClient,
      resolveModel: () => 'jev',
      logger: throwingLogger,
    });
    for (let index = 0; index < 4; index++) pilot.observeToolSelectionRequest(request(`held-${index}`));
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(4));
    await Promise.resolve();

    expect(() => pilot.observeToolSelectionRequest(request('held-4'))).not.toThrow();
    expect(decide).toHaveBeenCalledTimes(4);
    expect(() =>
      pilot.observeToolSelectionOutcome({
        requestId: 'held-0',
        outcome: 'tools',
        selections: [{ name: 'read_file', callPath: 'direct' }],
      }),
    ).not.toThrow();
  });

  it('retains bounded invalid tool predictions until their outcome can be scored', async () => {
    const decide = vi.fn(async () => ({
      answers: { case: { type: 'choice', choice: 'not_a_runtime_token', confidence: 1 } },
      resolvedModel: 'typesafe/jev-1.13',
      costUsdMicros: 11,
    }));
    let now = 100;
    const testLogger = logger();
    const pilot = new DecisionShadowPilot({
      client: { decide } as DecisionClient,
      resolveModel: () => '~typesafe/jev-latest',
      logger: testLogger,
      now: () => now,
    });

    for (let index = 0; index < 4; index++) {
      pilot.observeToolSelectionRequest(request(`invalid-${index}`));
    }
    now = 125;
    await vi.waitFor(() => expect(testLogger.warn).toHaveBeenCalledTimes(4));

    pilot.observeToolSelectionRequest(request('invalid-at-capacity'));
    expect(decide).toHaveBeenCalledTimes(4);
    expect(testLogger.warn).toHaveBeenCalledWith(
      'Decision shadow observation failed',
      expect.objectContaining({
        eventType: 'decision_shadow.failed',
        kind: 'tool_selection',
        requestId: 'invalid-0',
        requestedModel: '~typesafe/jev-latest',
        resolvedModel: 'typesafe/jev-1.13',
        latencyMs: 25,
        cost: 11,
        errorCode: 'invalid_choice',
      }),
    );

    pilot.observeToolSelectionOutcome({
      requestId: 'invalid-0',
      outcome: 'tools',
      selections: [{ name: 'read_file', callPath: 'direct' }],
    });
    expect(testLogger.info).toHaveBeenCalledWith(
      'Decision shadow tool-selection comparison',
      expect.objectContaining({
        requestId: 'invalid-0',
        predictionStatus: 'invalid',
        requestedModel: '~typesafe/jev-latest',
        resolvedModel: 'typesafe/jev-1.13',
        latencyMs: 25,
        cost: 11,
        observedOutcome: 'tools',
      }),
    );

    pilot.observeToolSelectionRequest(request('admitted-after-outcome'));
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(5));
  });

  it('freezes terminal failure evidence before starting the asynchronous prediction', async () => {
    const decide = vi.fn(async (_request: Parameters<DecisionClient['decide']>[0]) => ({
      answers: {
        category: { type: 'choice', choice: 'TRANSIENT_PROVIDER', confidence: 0.8 },
        retry: { type: 'choice', choice: 'RETRY', confidence: 0.7 },
      },
    }));
    const testLogger = logger();
    const pilot = new DecisionShadowPilot({
      client: { decide } as DecisionClient,
      resolveModel: () => 'jev',
      logger: testLogger,
    });
    const observation = terminalFailure('req-failure-snapshot');

    pilot.observeTerminalFailure(observation);
    expect(testLogger.info).toHaveBeenCalledWith('Decision shadow observation started', {
      eventType: 'decision_shadow.started',
      kind: 'failure_triage',
      requestId: 'req-failure-snapshot',
      requestedModel: 'jev',
      promptVersion: 'failure-triage-v2-runtime-evidence',
    });
    observation.evidence.message = 'mutated after observation';
    observation.comparison.retryable = false;

    await vi.waitFor(() =>
      expect(testLogger.info).toHaveBeenCalledWith(
        'Decision shadow failure-triage comparison',
        expect.objectContaining({ requestId: 'req-failure-snapshot' }),
      ),
    );
    expect(JSON.stringify(decide.mock.calls[0]![0].state)).toContain('provider overloaded');
    expect(JSON.stringify(decide.mock.calls[0]![0].state)).not.toContain('mutated after observation');
    expect(testLogger.info).toHaveBeenCalledWith(
      'Decision shadow failure-triage comparison',
      expect.objectContaining({ comparisonRetryable: true, observedOutcome: 'run_loop_failed' }),
    );
  });

  it('logs monotonic failure telemetry with explicit unknown response metadata', async () => {
    const testLogger = logger();
    let now = 80;
    const pilot = new DecisionShadowPilot({
      client: { decide: async () => Promise.reject(new TypeError('raw provider response')) },
      resolveModel: () => 'jev',
      logger: testLogger,
      now: () => now,
    });

    pilot.observeTerminalFailure(terminalFailure('failed-triage'));
    now = 95;

    await vi.waitFor(() =>
      expect(testLogger.warn).toHaveBeenCalledWith(
        'Decision shadow observation failed',
        expect.objectContaining({
          eventType: 'decision_shadow.failed',
          kind: 'failure_triage',
          requestId: 'failed-triage',
          requestedModel: 'jev',
          resolvedModel: 'unknown',
          latencyMs: 15,
          cost: 'unknown',
          errorType: 'TypeError',
        }),
      ),
    );
    expect(JSON.stringify(testLogger.warn.mock.calls)).not.toContain('raw provider response');
  });
});

function logger(): ILoggingService & Record<'info' | 'warn' | 'debug', ReturnType<typeof vi.fn>> {
  const value = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    security: vi.fn(),
    setCorrelationId: vi.fn(),
    getCorrelationId: vi.fn(),
    clearCorrelationId: vi.fn(),
  };
  return value as unknown as ILoggingService & Record<'info' | 'warn' | 'debug', ReturnType<typeof vi.fn>>;
}

it('records cancellation as a skipped triage request without contacting the model', async () => {
  const testLogger = logger();
  const decide = vi.fn();
  const pilot = new DecisionShadowPilot({ client: { decide }, resolveModel: () => 'jev', logger: testLogger });
  const observation = terminalFailure('cancelled-request');
  pilot.observeTerminalFailure({
    ...observation,
    comparison: { ...observation.comparison, cancelled: true, observedOutcome: 'cancelled' },
  });
  await Promise.resolve();
  expect(decide).not.toHaveBeenCalled();
  expect(testLogger.debug).toHaveBeenCalledWith(
    'Decision shadow observation skipped',
    expect.objectContaining({
      eventType: 'decision_shadow.skipped',
      reason: 'cancelled',
      requestId: 'cancelled-request',
    }),
  );
});
