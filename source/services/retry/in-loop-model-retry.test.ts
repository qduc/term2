import { describe, it, expect } from 'vitest';
import { classifyInLoopModelRetry, computeInLoopBackoffDelayMs, sleepWithAbort } from './in-loop-model-retry.js';
import { AmbiguousModelOutcomeError, ConversationStateNoProgressError } from './retry-errors.js';
import { WebSocketClosedEarlyError } from '../../providers/websocket-close-evidence.js';
import { GenerationGuardError } from '../agent-runtime/generation-guard.js';

describe('in-loop-model-retry', () => {
  it('classifies WebSocketClosedEarlyError as retryable chain_recovery', () => {
    const error = new WebSocketClosedEarlyError({ code: 1006, reason: '', unsentCount: 0 });
    const decision = classifyInLoopModelRetry(error, 0, 2, () => 0.5);

    expect(decision.retryable).toBe(true);
    if (decision.retryable) {
      expect(decision.kind).toBe('chain_recovery');
      expect(decision.delayMs).toBeGreaterThan(0);
    }
  });

  it('refuses in-loop chain recovery when the failed request was a chained delta', () => {
    const error = new Error('Invalid `previous_response_id`.');
    const decision = classifyInLoopModelRetry(error, 0, 2, () => 0.5, {
      previousResponseId: 'resp-prior',
    });

    expect(decision.retryable).toBe(false);
    if (!decision.retryable) {
      expect(decision.reason).toBe('chained_delta_not_self_contained');
    }
  });

  it('refuses in-loop retry of a chained delta after a connection drop', () => {
    const error = new WebSocketClosedEarlyError({ code: 1006, reason: '', unsentCount: 0 });
    const decision = classifyInLoopModelRetry(error, 0, 2, () => 0.5, {
      previousResponseId: 'resp-prior',
    });

    expect(decision.retryable).toBe(false);
    if (!decision.retryable) {
      expect(decision.reason).toBe('chained_delta_not_self_contained');
    }
  });

  it('still recovers Invalid previous_response_id in-loop when the request was already unchained', () => {
    const error = new Error('Invalid `previous_response_id`.');
    const decision = classifyInLoopModelRetry(error, 0, 2, () => 0.5);

    expect(decision.retryable).toBe(true);
    if (decision.retryable) {
      expect(decision.kind).toBe('chain_recovery');
    }
  });

  it('classifies AmbiguousModelOutcomeError wrapping a close error as chain_recovery', () => {
    const cause = new WebSocketClosedEarlyError({ code: 1006, reason: '' });
    const error = new AmbiguousModelOutcomeError('Stream ended early', { cause });
    const decision = classifyInLoopModelRetry(error, 0, 2, () => 0.5);

    expect(decision.retryable).toBe(true);
    if (decision.retryable) {
      expect(decision.kind).toBe('chain_recovery');
    }
  });

  it('classifies transient network errors as retryable', () => {
    const error = new Error('fetch failed: ECONNRESET');
    (error as any).code = 'ECONNRESET';
    const decision = classifyInLoopModelRetry(error, 0, 2, () => 0.5);

    expect(decision.retryable).toBe(true);
  });

  it('rejects retry when attempt reaches maxRetries', () => {
    const error = new WebSocketClosedEarlyError({ code: 1006 });
    const decision = classifyInLoopModelRetry(error, 2, 2, () => 0.5);

    expect(decision.retryable).toBe(false);
    if (!decision.retryable) {
      expect(decision.reason).toBe('max_retries_exceeded');
    }
  });

  it('rejects retry for aborted operations', () => {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    const decision = classifyInLoopModelRetry(error, 0, 2);

    expect(decision.retryable).toBe(false);
    if (!decision.retryable) {
      expect(decision.reason).toBe('aborted');
    }
  });

  it('rejects retry for the retained output-containment GenerationGuardError', () => {
    const error = new GenerationGuardError('output_characters', 'output limit exceeded');
    const decision = classifyInLoopModelRetry(error, 0, 2);

    expect(decision.retryable).toBe(false);
    if (!decision.retryable) {
      expect(decision.reason).toBe('generation_guard');
    }
  });

  it('rejects retry for ConversationStateNoProgressError', () => {
    const error = new ConversationStateNoProgressError();
    const decision = classifyInLoopModelRetry(error, 0, 2);

    expect(decision.retryable).toBe(false);
    if (!decision.retryable) {
      expect(decision.reason).toBe('no_progress');
    }
  });

  it('computes exponential backoff with jitter', () => {
    const delay1 = computeInLoopBackoffDelayMs(1, () => 0.5);
    const delay2 = computeInLoopBackoffDelayMs(2, () => 0.5);
    const delay3 = computeInLoopBackoffDelayMs(3, () => 0.5);

    expect(delay1).toBe(500);
    expect(delay2).toBe(1000);
    expect(delay3).toBe(2000);
  });

  it('sleepWithAbort aborts immediately if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(sleepWithAbort(1000, controller.signal)).rejects.toThrow('The operation was aborted.');
  });
});
