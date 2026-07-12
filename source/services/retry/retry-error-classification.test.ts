import { it, expect } from 'vitest';
import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import { ModelBehaviorError } from '@openai/agents';
import { OpenAICompatibleError, OpenRouterError, LongRetryDelayError } from '../../providers/common/provider-errors.js';
import {
  isNetworkProtocolError,
  isRetryableTransportError,
  isTransientRetryableError,
} from './retry-error-classification.js';

function asInstanceOf<T extends object>(prototype: object, props: Partial<T>): T {
  return Object.assign(Object.create(prototype), props) as T;
}

function createLoggerMock() {
  const calls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  return {
    calls,
    logger: {
      info(message: string, meta?: Record<string, unknown>) {
        calls.push({ message, meta });
      },
    },
  };
}

it('isNetworkProtocolError correctly flags network protocol errors', () => {
  expect(isNetworkProtocolError({ code: 'ENOTFOUND' })).toBe(true);
  expect(isNetworkProtocolError({ code: 'ECONNREFUSED' })).toBe(true);
  expect(isNetworkProtocolError({ code: 'ETIMEDOUT' })).toBe(true);
  expect(isNetworkProtocolError({ code: 'ECONNRESET' })).toBe(true);

  expect(isNetworkProtocolError(new Error('Responses websocket connection closed before opening.'))).toBe(true);
  expect(
    isNetworkProtocolError(new Error('Responses websocket connection closed before a terminal response event.')),
  ).toBe(true);
  expect(isNetworkProtocolError(new Error('Responses websocket is not open.'))).toBe(true);
  expect(isNetworkProtocolError(new Error('unexpected server response: 502'))).toBe(true);
  expect(
    isNetworkProtocolError(new Error('Responses websocket connection timed out before opening after 15000ms')),
  ).toBe(true);
  expect(isNetworkProtocolError(new Error('Responses websocket connection timed out'))).toBe(true);
  expect(isNetworkProtocolError(new Error('WebSocket first frame timeout after 5000ms'))).toBe(true);
  expect(isNetworkProtocolError(new Error('WebSocket idle timeout'))).toBe(true);
  expect(isNetworkProtocolError({ name: 'InvalidStateError', message: 'Socket is closing' })).toBe(true);

  expect(isNetworkProtocolError(new Error('unexpected server response: 401'))).toBe(false);
  expect(isNetworkProtocolError(new Error('unexpected server response: 403'))).toBe(false);
  expect(isNetworkProtocolError(new Error('unexpected server response: 429'))).toBe(false);
  expect(isNetworkProtocolError(new Error('unexpected server response: 400'))).toBe(false);
  expect(isNetworkProtocolError(new Error('unexpected server response: 404'))).toBe(false);
  expect(isNetworkProtocolError(new Error('unexpected server response: 502'))).toBe(true);

  expect(isNetworkProtocolError(new Error('Something else went wrong'))).toBe(false);
  expect(isNetworkProtocolError({})).toBe(false);
  expect(isNetworkProtocolError(null)).toBe(false);
});

it('isRetryableTransportError separates retryable errors from HTTP fallback candidates', () => {
  expect(isRetryableTransportError(new Error('WebSocket first frame timeout after 5000ms'))).toEqual({
    retryable: true,
    transportFallback: true,
  });
  expect(isRetryableTransportError(new Error('WebSocket idle timeout'))).toEqual({
    retryable: true,
    transportFallback: true,
  });
  expect(
    isRetryableTransportError(new Error('WebSocket connection closed before response completed (code=1006)')),
  ).toEqual({
    retryable: true,
    transportFallback: true,
  });
  expect(
    isRetryableTransportError(new Error('WebSocket connection closed before response completed (code=1001)')),
  ).toEqual({
    retryable: true,
    transportFallback: true,
  });
  expect(
    isRetryableTransportError(new Error('WebSocket connection closed before response completed (code=1012)')),
  ).toEqual({
    retryable: true,
    transportFallback: true,
  });
  expect(
    isRetryableTransportError(new Error('WebSocket connection closed before response completed (code=1008)')),
  ).toEqual({
    retryable: true,
    transportFallback: true,
  });
  expect(isRetryableTransportError(new Error('unexpected server response: 401'))).toEqual({
    retryable: false,
    transportFallback: false,
  });
});

it('isRetryableTransportError logs websocket close code at info level', () => {
  const { calls, logger } = createLoggerMock();

  const decision = isRetryableTransportError(
    new Error('WebSocket connection closed before response completed (code=1006)'),
    logger,
  );

  expect(decision).toEqual({ retryable: true, transportFallback: true });
  expect(calls.length).toBe(1);
  expect(calls[0]?.message).toBe('WebSocket close code detected');
  expect(calls[0]?.meta).toEqual({
    eventType: 'retry.websocket_close_code_detected',
    category: 'retry',
    closeCode: '1006',
    errorMessage: 'WebSocket connection closed before response completed (code=1006)',
  });
});

it('isTransientRetryableError: OpenAI SDK errors are retryable', () => {
  expect(isTransientRetryableError(asInstanceOf(APIConnectionError.prototype, { message: 'conn error' }))).toBe(true);
  expect(isTransientRetryableError(asInstanceOf(APIConnectionTimeoutError.prototype, { message: 'timeout' }))).toBe(
    true,
  );
  expect(isTransientRetryableError(asInstanceOf(InternalServerError.prototype, { message: 'ise', status: 500 }))).toBe(
    true,
  );
  expect(
    isTransientRetryableError(asInstanceOf(RateLimitError.prototype, { message: 'rate limit', status: 429 })),
  ).toBe(true);
});

it('isTransientRetryableError: websocket receive watchdog timeouts are retryable', () => {
  expect(isTransientRetryableError(new Error('WebSocket first frame timeout'))).toBe(true);
  expect(isTransientRetryableError(new Error('WebSocket idle timeout'))).toBe(true);
});

it('isTransientRetryableError: OpenRouter 429/5xx are retryable', () => {
  expect(isTransientRetryableError(new OpenRouterError('rate limited', 429, {}))).toBe(true);
  expect(isTransientRetryableError(new OpenRouterError('server error', 500, {}))).toBe(true);
  expect(isTransientRetryableError(new OpenRouterError('bad gateway', 502, {}))).toBe(true);
  expect(isTransientRetryableError(new OpenRouterError('not found', 404, {}))).toBe(false);
});

it('isTransientRetryableError: OpenAI-compatible 429/5xx are retryable', () => {
  expect(isTransientRetryableError(new OpenAICompatibleError('rate limited', 429, {}))).toBe(true);
  expect(isTransientRetryableError(new OpenAICompatibleError('server error', 503, {}))).toBe(true);
  expect(isTransientRetryableError(new OpenAICompatibleError('bad request', 400, {}))).toBe(false);
});

it('isTransientRetryableError: generic errors with 429/5xx status are retryable', () => {
  const err429 = new Error('too many requests');
  (err429 as any).status = 429;
  expect(isTransientRetryableError(err429)).toBe(true);

  const err503 = new Error('service unavailable');
  (err503 as any).statusCode = 503;
  expect(isTransientRetryableError(err503)).toBe(true);
});

it('isTransientRetryableError: generic errors with rate-limit message are retryable', () => {
  expect(
    isTransientRetryableError(new Error("We're currently processing too many requests — please try again later.")),
  ).toBe(true);
  expect(isTransientRetryableError(new Error('Rate limit exceeded'))).toBe(true);
  expect(isTransientRetryableError(new Error('rate_limit retry after 10s'))).toBe(true);
});

it('isTransientRetryableError: websocket response completion closes are retryable unless policy close code is present', () => {
  expect(isTransientRetryableError(new Error('WebSocket connection closed before response completed'))).toBe(true);
  expect(
    isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1006)')),
  ).toBe(true);
  expect(
    isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1001)')),
  ).toBe(true);
  expect(
    isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1011)')),
  ).toBe(true);
  expect(
    isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1012)')),
  ).toBe(true);
  expect(
    isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1013)')),
  ).toBe(true);
  expect(
    isTransientRetryableError(new Error('WebSocket closed before response.completed (code 1006: Connection ended)')),
  ).toBe(true);
  expect(
    isTransientRetryableError(
      new Error('WebSocket connection closed before response completed (code=1008, reason="rate limit exceeded")'),
    ),
  ).toBe(false);
  expect(
    isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1002)')),
  ).toBe(false);
  expect(
    isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1003)')),
  ).toBe(false);
});

it('isTransientRetryableError logs websocket close code at info level', () => {
  const { calls, logger } = createLoggerMock();

  expect(
    isTransientRetryableError(
      new Error('WebSocket connection closed before response completed (code=1012, reason="service restart")'),
      logger,
    ),
  ).toBe(true);

  expect(calls.length).toBe(1);
  expect(calls[0]?.message).toBe('WebSocket close code detected');
  expect(calls[0]?.meta).toEqual({
    eventType: 'retry.websocket_close_code_detected',
    category: 'retry',
    closeCode: '1012',
    errorMessage: 'WebSocket connection closed before response completed (code=1012, reason="service restart")',
  });
});

it('isTransientRetryableError: terminated errors are retryable', () => {
  expect(isTransientRetryableError('terminated')).toBe(true);
  expect(isTransientRetryableError('terminated: other side closed')).toBe(true);
  expect(isTransientRetryableError(new Error('terminated'))).toBe(true);
  expect(isTransientRetryableError(new Error('terminated: other side closed'))).toBe(true);
});

it('isTransientRetryableError: RateLimitExceededError is never retryable', () => {
  expect(isTransientRetryableError(new LongRetryDelayError(120))).toBe(false);
  expect(isTransientRetryableError(new LongRetryDelayError(300))).toBe(false);
});

it('isTransientRetryableError: RateLimitError with retry-after > 60s is not retryable', () => {
  const err = new RateLimitError(429, 'rate limited', 'rate limited', { get: () => '120' } as any);
  expect(isTransientRetryableError(err)).toBe(false);
});

it('isTransientRetryableError: RateLimitError with retry-after <= 60s is retryable', () => {
  const err = new RateLimitError(429, 'rate limited', 'rate limited', { get: () => '30' } as any);
  expect(isTransientRetryableError(err)).toBe(true);
});

it('isTransientRetryableError: RateLimitError without retry-after is retryable', () => {
  const err = new RateLimitError(429, 'rate limited', 'rate limited', { get: () => null } as any);
  expect(isTransientRetryableError(err)).toBe(true);
});

it('isTransientRetryableError: non-retryable errors return false', () => {
  expect(isTransientRetryableError(new Error('something else'))).toBe(false);
  expect(isTransientRetryableError(new ModelBehaviorError('Tool x not found'))).toBe(false);
  expect(isTransientRetryableError(null)).toBe(false);
  expect(isTransientRetryableError('string error')).toBe(false);
  expect(isTransientRetryableError('unterminated string')).toBe(false);
  expect(isTransientRetryableError(new Error('unterminated string'))).toBe(false);
  expect(isTransientRetryableError(42)).toBe(false);
});

it('isTransientRetryableError: stream parsing and JSON syntax errors are retryable', () => {
  expect(isTransientRetryableError(new Error("Expecting ',' delimiter: line 1 column 680 (char 679)"))).toBe(true);
  expect(isTransientRetryableError(new SyntaxError('Unexpected end of JSON input'))).toBe(true);
  expect(isTransientRetryableError(new Error('Unexpected token < in JSON at position 0'))).toBe(true);
  expect(
    isTransientRetryableError(new SyntaxError('Expected double-quoted property name in JSON at position 39')),
  ).toBe(true);

  // Undici throws a bare `new TypeError()` (empty message, no code) when the
  // TLS socket closes mid-response-body. Stack originates in #onSocketClose.
  const undiciSocketClose = new TypeError();
  undiciSocketClose.stack = [
    'TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
    '    at TLSSocket.emit (node:events:520:35)',
  ].join('\n');
  expect(isNetworkProtocolError(undiciSocketClose)).toBe(true);
  expect(isTransientRetryableError(undiciSocketClose)).toBe(true);
  expect(isRetryableTransportError(undiciSocketClose)).toEqual({ retryable: true, transportFallback: true });

  // Non-undici TypeError with empty message must NOT be flagged.
  const plainTypeError = new TypeError();
  plainTypeError.stack = 'TypeError\n    at userCode (file.ts:1:1)';
  expect(isNetworkProtocolError(plainTypeError)).toBe(false);
  expect(isTransientRetryableError(plainTypeError)).toBe(false);

  // TypeError with a real message must NOT be flagged as a socket close.
  const typedValueError = new TypeError('Cannot read properties of undefined');
  expect(isNetworkProtocolError(typedValueError)).toBe(false);

  // Re-wrapped undici socket close: plain Error with message "TypeError"
  // and the original undici stack frames. Intermediate layers (SDK wrappers,
  // stream collectors) may re-wrap the canonical bare TypeError into this form.
  const rewrappedUndiciSocketClose = new Error('TypeError');
  rewrappedUndiciSocketClose.stack = [
    'Error: TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
    '    at TLSSocket.emit (node:events:520:35)',
  ].join('\n');
  expect(isNetworkProtocolError(rewrappedUndiciSocketClose)).toBe(true);
  expect(isTransientRetryableError(rewrappedUndiciSocketClose)).toBe(true);
  expect(isRetryableTransportError(rewrappedUndiciSocketClose)).toEqual({ retryable: true, transportFallback: true });

  // Plain Error with message "TypeError" but NO undici stack must NOT be flagged.
  const plainErrorWithTypeError = new Error('TypeError');
  plainErrorWithTypeError.stack = 'Error: TypeError\n    at userCode (file.ts:1:1)';
  expect(isNetworkProtocolError(plainErrorWithTypeError)).toBe(false);
  expect(isTransientRetryableError(plainErrorWithTypeError)).toBe(false);
});

it('isNetworkProtocolError and isTransientRetryableError recursive cause-chain walking and undici timeouts', () => {
  // - TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }) → retryable
  const connectTimeout = new TypeError('fetch failed');
  (connectTimeout as any).cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
  expect(isNetworkProtocolError(connectTimeout)).toBe(true);
  expect(isTransientRetryableError(connectTimeout)).toBe(true);
  expect(isRetryableTransportError(connectTimeout)).toEqual({ retryable: true, transportFallback: true });

  // - TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }) → retryable
  const headersTimeout = new TypeError('fetch failed');
  (headersTimeout as any).cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
  expect(isNetworkProtocolError(headersTimeout)).toBe(true);
  expect(isTransientRetryableError(headersTimeout)).toBe(true);

  // - TypeError("fetch failed", { cause: { code: "UND_ERR_BODY_TIMEOUT" } }) → retryable
  const bodyTimeout = new TypeError('fetch failed');
  (bodyTimeout as any).cause = { code: 'UND_ERR_BODY_TIMEOUT' };
  expect(isNetworkProtocolError(bodyTimeout)).toBe(true);
  expect(isTransientRetryableError(bodyTimeout)).toBe(true);

  // - TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } }) → retryable
  const sysTimeout = new TypeError('fetch failed');
  (sysTimeout as any).cause = { code: 'ETIMEDOUT' };
  expect(isNetworkProtocolError(sysTimeout)).toBe(true);
  expect(isTransientRetryableError(sysTimeout)).toBe(true);

  // - TypeError("fetch failed", { cause: new Error("DEPTH_ZERO_SELF_SIGNED_CERT") }) → NOT retryable
  const certError = new TypeError('fetch failed');
  (certError as any).cause = new Error('DEPTH_ZERO_SELF_SIGNED_CERT');
  expect(isNetworkProtocolError(certError)).toBe(false);
  expect(isTransientRetryableError(certError)).toBe(false);

  // - Plain TypeError("fetch failed") without cause → NOT retryable
  const plainFetchFailed = new TypeError('fetch failed');
  expect(isNetworkProtocolError(plainFetchFailed)).toBe(false);
  expect(isTransientRetryableError(plainFetchFailed)).toBe(false);

  // - AggregateError([{ code: "ETIMEDOUT" }]) → retryable
  const aggregateError = new Error('Multiple failures');
  (aggregateError as any).errors = [{ code: 'ETIMEDOUT' }];
  expect(isNetworkProtocolError(aggregateError)).toBe(true);
  expect(isTransientRetryableError(aggregateError)).toBe(true);

  // - Cyclic .cause → does not hang
  const cyclicError = new Error('Cyclic error');
  (cyclicError as any).cause = cyclicError;
  expect(isNetworkProtocolError(cyclicError)).toBe(false);
  expect(isTransientRetryableError(cyclicError)).toBe(false);

  // - 3-level deep cause chain → correctly classified
  const deepError = new Error('Outer');
  const midError = new Error('Mid');
  const innerError = new Error('Inner');
  (innerError as any).code = 'ECONNREFUSED';
  (midError as any).cause = innerError;
  (deepError as any).cause = midError;
  expect(isNetworkProtocolError(deepError)).toBe(true);
  expect(isTransientRetryableError(deepError)).toBe(true);

  // Verify consistency of isTransientRetryableError and isRetryableTransportError
  const cases = [
    connectTimeout,
    headersTimeout,
    bodyTimeout,
    sysTimeout,
    certError,
    plainFetchFailed,
    aggregateError,
    cyclicError,
    deepError,
  ];
  for (const c of cases) {
    expect(isTransientRetryableError(c)).toBe(isRetryableTransportError(c).retryable);
  }
});

it('isNetworkProtocolError and isTransientRetryableError findings regression tests', () => {
  // P1: Status/authentication rejection precedence
  const authRejectionError = new Error('unexpected server response: 401');
  (authRejectionError as any).cause = { code: 'ETIMEDOUT' };
  expect(isNetworkProtocolError(authRejectionError)).toBe(false);
  expect(isTransientRetryableError(authRejectionError)).toBe(false);

  // P1: Wrapped WebSocket messages, InvalidStateError, and undici stack signals in cause
  const wrappedWsError = new Error('Wrapper');
  (wrappedWsError as any).cause = new Error('Responses websocket connection closed before opening.');
  expect(isNetworkProtocolError(wrappedWsError)).toBe(true);
  expect(isTransientRetryableError(wrappedWsError)).toBe(true);

  const wrappedInvalidState = new Error('Wrapper');
  (wrappedInvalidState as any).cause = { name: 'InvalidStateError', message: 'Socket is closing' };
  expect(isNetworkProtocolError(wrappedInvalidState)).toBe(true);
  expect(isTransientRetryableError(wrappedInvalidState)).toBe(true);

  const undiciSocketClose = new TypeError();
  undiciSocketClose.stack = [
    'TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
    '    at TLSSocket.emit (node:events:520:35)',
  ].join('\n');
  const wrappedUndici = new Error('Wrapper');
  (wrappedUndici as any).cause = undiciSocketClose;
  expect(isNetworkProtocolError(wrappedUndici)).toBe(true);
  expect(isTransientRetryableError(wrappedUndici)).toBe(true);

  // P2: Restored message signals
  const socketHangup = new Error('socket hang up');
  expect(isNetworkProtocolError(socketHangup)).toBe(true);
  expect(isTransientRetryableError(socketHangup)).toBe(true);

  const connFailed = new Error('connection failed');
  expect(isNetworkProtocolError(connFailed)).toBe(true);
  expect(isTransientRetryableError(connFailed)).toBe(true);

  const failedToOpen = new Error('failed to open');
  expect(isNetworkProtocolError(failedToOpen)).toBe(true);
  expect(isTransientRetryableError(failedToOpen)).toBe(true);

  const connError = new Error('connection error');
  expect(isNetworkProtocolError(connError)).toBe(true);
  expect(isTransientRetryableError(connError)).toBe(true);
});

it('isNetworkProtocolError and isTransientRetryableError handle 520 status code and Cloudflare 520 errors', () => {
  // Error object with message "520 status code (no body)"
  const errNoBody = new Error('520 status code (no body)');
  expect(isNetworkProtocolError(errNoBody)).toBe(true);
  expect(isTransientRetryableError(errNoBody)).toBe(true);

  // Error object with status property = 520
  const errStatus = Object.assign(new Error('Cloudflare error'), { status: 520 });
  expect(isNetworkProtocolError(errStatus)).toBe(true);
  expect(isTransientRetryableError(errStatus)).toBe(true);

  // Error object with statusCode property = 520
  const errStatusCode = Object.assign(new Error('Cloudflare error'), { statusCode: 520 });
  expect(isNetworkProtocolError(errStatusCode)).toBe(true);
  expect(isTransientRetryableError(errStatusCode)).toBe(true);

  // Error message with "unexpected server response: 520"
  const errUnexpected520 = new Error('unexpected server response: 520');
  expect(isNetworkProtocolError(errUnexpected520)).toBe(true);
  expect(isTransientRetryableError(errUnexpected520)).toBe(true);

  // String error
  const stringErr = 'Error: 520 status code (no body)';
  expect(isNetworkProtocolError(stringErr)).toBe(true);
  expect(isTransientRetryableError(stringErr)).toBe(true);
});
