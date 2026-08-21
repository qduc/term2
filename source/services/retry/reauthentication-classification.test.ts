import { describe, it, expect } from 'vitest';
import { APIConnectionError } from 'openai';
import { ProviderReauthenticationRequiredError } from '../../providers/common/provider-errors.js';
import {
  isTransientRetryableError,
  isRetryableTransportError,
  isNetworkProtocolError,
} from './retry-error-classification.js';

// An expired credential with no refresh token is thrown from inside the
// provider's fetch middleware, so the OpenAI SDK re-throws it as
// `APIConnectionError('Connection error.')` with our error as the cause.
// Classifying that wrapper as a transient network fault burned ~9 retries
// across three retry layers on a failure only a human re-login can clear.
const wrapped = () => {
  const cause = new ProviderReauthenticationRequiredError(
    'The access token imported from the `grok` CLI has expired. Run `term2 --grok-login` so term2 holds its own credential.',
  );
  const wrapper: any = Object.create(APIConnectionError.prototype);
  wrapper.message = 'Connection error.';
  wrapper.cause = cause;
  return wrapper;
};

describe('re-authentication failures are never retried', () => {
  it('isTransientRetryableError rejects a wrapped re-auth failure', () => {
    expect(isTransientRetryableError(wrapped())).toBe(false);
  });

  it('isRetryableTransportError rejects a wrapped re-auth failure', () => {
    expect(isRetryableTransportError(wrapped())).toEqual({ retryable: false, transportFallback: false });
  });

  it('isNetworkProtocolError rejects a wrapped re-auth failure', () => {
    expect(isNetworkProtocolError(wrapped())).toBe(false);
  });

  it('still treats a genuine APIConnectionError as retryable', () => {
    const plain: any = Object.create(APIConnectionError.prototype);
    plain.message = 'Connection error.';
    expect(isTransientRetryableError(plain)).toBe(true);
  });
});
