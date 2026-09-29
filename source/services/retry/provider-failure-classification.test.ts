import { describe, expect, it } from 'vitest';
import { OpenAICompatibleError } from '../../providers/common/provider-errors.js';
import {
  classifyProviderFailure,
  classifyPoolEntryFailure,
  hasExplicitCancellationMarker,
  isClassifiedCancellation,
} from './provider-failure-classification.js';

const abortError = (): Error => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

describe('hasExplicitCancellationMarker', () => {
  it.each([
    ['AbortError', abortError()],
    ['ABORT_ERR', Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })],
  ])('recognizes a pure %s marker', (_label, error) => {
    expect(hasExplicitCancellationMarker(error)).toBe(true);
    expect(isClassifiedCancellation(error)).toBe(true);
  });

  it('recognizes cancellation through a wrapper cause', () => {
    const wrapped = new Error('request was cancelled', { cause: abortError() });

    expect(hasExplicitCancellationMarker(wrapped)).toBe(true);
    expect(isClassifiedCancellation(wrapped)).toBe(true);
  });

  it('does not treat an unclassified kind field as a cancellation marker', () => {
    const value = { kind: 'cancelled' };

    expect(classifyProviderFailure(value).errorKind).not.toBe('cancelled');
    expect(hasExplicitCancellationMarker(value)).toBe(false);
    expect(isClassifiedCancellation(value)).toBe(false);
  });

  it('terminates on a cause cycle without inventing a cancellation marker', () => {
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;

    expect(hasExplicitCancellationMarker(cycle)).toBe(false);
  });

  it.each([
    ['a provider status', Object.assign(new Error('upstream failed'), { status: 503 })],
    ['a network code', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })],
  ])('rejects a mixed aggregate containing %s', (_label, failure) => {
    const mixed = new AggregateError([abortError(), failure], 'request failed during cancellation');

    expect(classifyProviderFailure(mixed).errorKind).toBe('cancelled');
    expect(hasExplicitCancellationMarker(mixed)).toBe(false);
    expect(isClassifiedCancellation(mixed)).toBe(false);
  });

  it('rejects a provider error whose cause is an abort', () => {
    const providerError = new OpenAICompatibleError('upstream failed', 503, {});
    providerError.cause = abortError();

    expect(classifyProviderFailure(providerError).errorKind).toBe('cancelled');
    expect(hasExplicitCancellationMarker(providerError)).toBe(false);
    expect(isClassifiedCancellation(providerError)).toBe(false);
  });
});

describe('classifyPoolEntryFailure', () => {
  it.each([
    [Object.assign(new Error('Payment Required'), { status: 402 }), 'balance'],
    [new OpenAICompatibleError('request failed', 400, {}, '{"error":{"code":"insufficient_quota"}}'), 'balance'],
    [Object.assign(new Error('request failed'), { status: 400, error: { type: 'insufficient_credits' } }), 'balance'],
    [new Error('402 Insufficient Balance'), 'balance'],
    [Object.assign(new Error('invalid api key'), { status: 401 }), 'authentication'],
  ])('recognizes permanent pool entry failure %#', (error, expected) => {
    expect(classifyPoolEntryFailure(error)).toBe(expected);
  });

  it.each([
    Object.assign(new Error('quota exceeded'), { status: 429, headers: { 'retry-after': '5' } }),
    Object.assign(new Error('insufficient balance'), { status: 503 }),
    new Error('quota exceeded'),
  ])('does not quarantine transient or ambiguous failures %#', (error) => {
    expect(classifyPoolEntryFailure(error)).toBeUndefined();
  });
});
