import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterDecisionClient } from './decision-client.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { DecisionClient } from './decision-client.js';
import { DecisionShadowPilot } from './decision-shadow-pilot.js';

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

    pilot.observeTerminalFailure(terminalFailure('req-1'));
    await Promise.resolve();
    expect(decide).not.toHaveBeenCalled();
  });

  it('admits at most four simultaneous terminal-failure observations and swallows failures', async () => {
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

    for (let index = 0; index < 5; index++) pilot.observeTerminalFailure(terminalFailure(`req-${index}`));
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
    for (let index = 0; index < 4; index++) pilot.observeTerminalFailure(terminalFailure(`active-${index}`));
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

  it('logs an HTTP failure category and status without its response body', async () => {
    const testLogger = logger();
    const client = createOpenRouterDecisionClient({
      resolveTransport: () => ({ apiKey: 'test-key' }),
      fetchImpl: vi.fn(async () => new Response('private provider response', { status: 401 })),
    });
    const pilot = new DecisionShadowPilot({ client, resolveModel: () => 'jev', logger: testLogger });

    pilot.observeTerminalFailure(terminalFailure('http-failure'));

    await vi.waitFor(() =>
      expect(testLogger.warn).toHaveBeenCalledWith(
        'Decision shadow observation failed',
        expect.objectContaining({
          requestId: 'http-failure',
          errorType: 'OpenRouterDecisionError',
          errorCode: 'http_error',
          httpStatus: 401,
        }),
      ),
    );
    expect(JSON.stringify(testLogger.warn.mock.calls)).not.toContain('private provider response');
  });

  it('contains throwing loggers without affecting the foreground', async () => {
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
      client: { decide: async () => ({ answers: {} }) } as DecisionClient,
      resolveModel: () => 'jev',
      logger: throwingLogger,
    });
    for (let index = 0; index < 5; index++) {
      expect(() => pilot.observeTerminalFailure(terminalFailure(`throw-${index}`))).not.toThrow();
    }
    await Promise.resolve();
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
