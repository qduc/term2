import test from 'ava';
import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import { ModelBehaviorError } from '@openai/agents';
import { OpenAICompatibleError, OpenRouterError } from '../../providers/common/provider-errors.js';
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

test('isNetworkProtocolError correctly flags network protocol errors', (t) => {
  t.true(isNetworkProtocolError({ code: 'ENOTFOUND' }));
  t.true(isNetworkProtocolError({ code: 'ECONNREFUSED' }));
  t.true(isNetworkProtocolError({ code: 'ETIMEDOUT' }));
  t.true(isNetworkProtocolError({ code: 'ECONNRESET' }));

  t.true(isNetworkProtocolError(new Error('Responses websocket connection closed before opening.')));
  t.true(isNetworkProtocolError(new Error('Responses websocket connection closed before a terminal response event.')));
  t.true(isNetworkProtocolError(new Error('Responses websocket is not open.')));
  t.true(isNetworkProtocolError(new Error('unexpected server response: 502')));
  t.true(isNetworkProtocolError(new Error('Responses websocket connection timed out before opening after 15000ms')));
  t.true(isNetworkProtocolError(new Error('Responses websocket connection timed out')));
  t.true(isNetworkProtocolError(new Error('WebSocket first frame timeout after 5000ms')));
  t.true(isNetworkProtocolError({ name: 'InvalidStateError', message: 'Socket is closing' }));

  t.false(isNetworkProtocolError(new Error('unexpected server response: 401')));
  t.false(isNetworkProtocolError(new Error('unexpected server response: 403')));
  t.false(isNetworkProtocolError(new Error('unexpected server response: 429')));
  t.false(isNetworkProtocolError(new Error('unexpected server response: 400')));
  t.false(isNetworkProtocolError(new Error('unexpected server response: 404')));
  t.true(isNetworkProtocolError(new Error('unexpected server response: 502')));

  t.false(isNetworkProtocolError(new Error('Something else went wrong')));
  t.false(isNetworkProtocolError({}));
  t.false(isNetworkProtocolError(null));
});

test('isRetryableTransportError separates retryable errors from HTTP fallback candidates', (t) => {
  t.deepEqual(isRetryableTransportError(new Error('WebSocket first frame timeout after 5000ms')), {
    retryable: true,
    transportFallback: true,
  });
  t.deepEqual(
    isRetryableTransportError(new Error('WebSocket connection closed before response completed (code=1006)')),
    {
      retryable: true,
      transportFallback: true,
    },
  );
  t.deepEqual(
    isRetryableTransportError(new Error('WebSocket connection closed before response completed (code=1001)')),
    {
      retryable: true,
      transportFallback: true,
    },
  );
  t.deepEqual(
    isRetryableTransportError(new Error('WebSocket connection closed before response completed (code=1012)')),
    {
      retryable: true,
      transportFallback: true,
    },
  );
  t.deepEqual(
    isRetryableTransportError(new Error('WebSocket connection closed before response completed (code=1008)')),
    {
      retryable: true,
      transportFallback: true,
    },
  );
  t.deepEqual(isRetryableTransportError(new Error('unexpected server response: 401')), {
    retryable: false,
    transportFallback: false,
  });
});

test('isRetryableTransportError logs websocket close code at info level', (t) => {
  const { calls, logger } = createLoggerMock();

  const decision = isRetryableTransportError(
    new Error('WebSocket connection closed before response completed (code=1006)'),
    logger,
  );

  t.deepEqual(decision, { retryable: true, transportFallback: true });
  t.is(calls.length, 1);
  t.is(calls[0]?.message, 'WebSocket close code detected');
  t.deepEqual(calls[0]?.meta, {
    eventType: 'retry.websocket_close_code_detected',
    category: 'retry',
    closeCode: '1006',
    errorMessage: 'WebSocket connection closed before response completed (code=1006)',
  });
});

test('isTransientRetryableError: OpenAI SDK errors are retryable', (t) => {
  t.true(isTransientRetryableError(asInstanceOf(APIConnectionError.prototype, { message: 'conn error' })));
  t.true(isTransientRetryableError(asInstanceOf(APIConnectionTimeoutError.prototype, { message: 'timeout' })));
  t.true(isTransientRetryableError(asInstanceOf(InternalServerError.prototype, { message: 'ise', status: 500 })));
  t.true(isTransientRetryableError(asInstanceOf(RateLimitError.prototype, { message: 'rate limit', status: 429 })));
});

test('isTransientRetryableError: OpenRouter 429/5xx are retryable', (t) => {
  t.true(isTransientRetryableError(new OpenRouterError('rate limited', 429, {})));
  t.true(isTransientRetryableError(new OpenRouterError('server error', 500, {})));
  t.true(isTransientRetryableError(new OpenRouterError('bad gateway', 502, {})));
  t.false(isTransientRetryableError(new OpenRouterError('not found', 404, {})));
});

test('isTransientRetryableError: OpenAI-compatible 429/5xx are retryable', (t) => {
  t.true(isTransientRetryableError(new OpenAICompatibleError('rate limited', 429, {})));
  t.true(isTransientRetryableError(new OpenAICompatibleError('server error', 503, {})));
  t.false(isTransientRetryableError(new OpenAICompatibleError('bad request', 400, {})));
});

test('isTransientRetryableError: generic errors with 429/5xx status are retryable', (t) => {
  const err429 = new Error('too many requests');
  (err429 as any).status = 429;
  t.true(isTransientRetryableError(err429));

  const err503 = new Error('service unavailable');
  (err503 as any).statusCode = 503;
  t.true(isTransientRetryableError(err503));
});

test('isTransientRetryableError: generic errors with rate-limit message are retryable', (t) => {
  t.true(
    isTransientRetryableError(new Error("We're currently processing too many requests — please try again later.")),
  );
  t.true(isTransientRetryableError(new Error('Rate limit exceeded')));
  t.true(isTransientRetryableError(new Error('rate_limit retry after 10s')));
});

test('isTransientRetryableError: websocket response completion closes are retryable unless policy close code is present', (t) => {
  t.true(isTransientRetryableError(new Error('WebSocket connection closed before response completed')));
  t.true(isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1006)')));
  t.true(isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1001)')));
  t.true(isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1011)')));
  t.true(isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1012)')));
  t.true(isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1013)')));
  t.true(
    isTransientRetryableError(new Error('WebSocket closed before response.completed (code 1006: Connection ended)')),
  );
  t.false(
    isTransientRetryableError(
      new Error('WebSocket connection closed before response completed (code=1008, reason="rate limit exceeded")'),
    ),
  );
  t.false(isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1002)')));
  t.false(isTransientRetryableError(new Error('WebSocket connection closed before response completed (code=1003)')));
});

test('isTransientRetryableError logs websocket close code at info level', (t) => {
  const { calls, logger } = createLoggerMock();

  t.true(
    isTransientRetryableError(
      new Error('WebSocket connection closed before response completed (code=1012, reason="service restart")'),
      logger,
    ),
  );

  t.is(calls.length, 1);
  t.is(calls[0]?.message, 'WebSocket close code detected');
  t.deepEqual(calls[0]?.meta, {
    eventType: 'retry.websocket_close_code_detected',
    category: 'retry',
    closeCode: '1012',
    errorMessage: 'WebSocket connection closed before response completed (code=1012, reason="service restart")',
  });
});

test('isTransientRetryableError: terminated errors are retryable', (t) => {
  t.true(isTransientRetryableError('terminated'));
  t.true(isTransientRetryableError('terminated: other side closed'));
  t.true(isTransientRetryableError(new Error('terminated')));
  t.true(isTransientRetryableError(new Error('terminated: other side closed')));
});

test('isTransientRetryableError: non-retryable errors return false', (t) => {
  t.false(isTransientRetryableError(new Error('something else')));
  t.false(isTransientRetryableError(new ModelBehaviorError('Tool x not found')));
  t.false(isTransientRetryableError(null));
  t.false(isTransientRetryableError('string error'));
  t.false(isTransientRetryableError('unterminated string'));
  t.false(isTransientRetryableError(new Error('unterminated string')));
  t.false(isTransientRetryableError(42));
});

test('isTransientRetryableError: stream parsing and JSON syntax errors are retryable', (t) => {
  t.true(isTransientRetryableError(new Error("Expecting ',' delimiter: line 1 column 680 (char 679)")));
  t.true(isTransientRetryableError(new SyntaxError('Unexpected end of JSON input')));
  t.true(isTransientRetryableError(new Error('Unexpected token < in JSON at position 0')));
  t.true(isTransientRetryableError(new SyntaxError('Expected double-quoted property name in JSON at position 39')));

  // Undici throws a bare `new TypeError()` (empty message, no code) when the
  // TLS socket closes mid-response-body. Stack originates in #onSocketClose.
  const undiciSocketClose = new TypeError();
  undiciSocketClose.stack = [
    'TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
    '    at TLSSocket.emit (node:events:520:35)',
  ].join('\n');
  t.true(isNetworkProtocolError(undiciSocketClose));
  t.true(isTransientRetryableError(undiciSocketClose));
  t.deepEqual(isRetryableTransportError(undiciSocketClose), { retryable: true, transportFallback: true });

  // Non-undici TypeError with empty message must NOT be flagged.
  const plainTypeError = new TypeError();
  plainTypeError.stack = 'TypeError\n    at userCode (file.ts:1:1)';
  t.false(isNetworkProtocolError(plainTypeError));
  t.false(isTransientRetryableError(plainTypeError));

  // TypeError with a real message must NOT be flagged as a socket close.
  const typedValueError = new TypeError('Cannot read properties of undefined');
  t.false(isNetworkProtocolError(typedValueError));

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
  t.true(isNetworkProtocolError(rewrappedUndiciSocketClose));
  t.true(isTransientRetryableError(rewrappedUndiciSocketClose));
  t.deepEqual(isRetryableTransportError(rewrappedUndiciSocketClose), { retryable: true, transportFallback: true });

  // Plain Error with message "TypeError" but NO undici stack must NOT be flagged.
  const plainErrorWithTypeError = new Error('TypeError');
  plainErrorWithTypeError.stack = 'Error: TypeError\n    at userCode (file.ts:1:1)';
  t.false(isNetworkProtocolError(plainErrorWithTypeError));
  t.false(isTransientRetryableError(plainErrorWithTypeError));
});

test('isNetworkProtocolError and isTransientRetryableError recursive cause-chain walking and undici timeouts', (t) => {
  // - TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }) → retryable
  const connectTimeout = new TypeError('fetch failed');
  (connectTimeout as any).cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
  t.true(isNetworkProtocolError(connectTimeout));
  t.true(isTransientRetryableError(connectTimeout));
  t.deepEqual(isRetryableTransportError(connectTimeout), { retryable: true, transportFallback: true });

  // - TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }) → retryable
  const headersTimeout = new TypeError('fetch failed');
  (headersTimeout as any).cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
  t.true(isNetworkProtocolError(headersTimeout));
  t.true(isTransientRetryableError(headersTimeout));

  // - TypeError("fetch failed", { cause: { code: "UND_ERR_BODY_TIMEOUT" } }) → retryable
  const bodyTimeout = new TypeError('fetch failed');
  (bodyTimeout as any).cause = { code: 'UND_ERR_BODY_TIMEOUT' };
  t.true(isNetworkProtocolError(bodyTimeout));
  t.true(isTransientRetryableError(bodyTimeout));

  // - TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } }) → retryable
  const sysTimeout = new TypeError('fetch failed');
  (sysTimeout as any).cause = { code: 'ETIMEDOUT' };
  t.true(isNetworkProtocolError(sysTimeout));
  t.true(isTransientRetryableError(sysTimeout));

  // - TypeError("fetch failed", { cause: new Error("DEPTH_ZERO_SELF_SIGNED_CERT") }) → NOT retryable
  const certError = new TypeError('fetch failed');
  (certError as any).cause = new Error('DEPTH_ZERO_SELF_SIGNED_CERT');
  t.false(isNetworkProtocolError(certError));
  t.false(isTransientRetryableError(certError));

  // - Plain TypeError("fetch failed") without cause → NOT retryable
  const plainFetchFailed = new TypeError('fetch failed');
  t.false(isNetworkProtocolError(plainFetchFailed));
  t.false(isTransientRetryableError(plainFetchFailed));

  // - AggregateError([{ code: "ETIMEDOUT" }]) → retryable
  const aggregateError = new Error('Multiple failures');
  (aggregateError as any).errors = [{ code: 'ETIMEDOUT' }];
  t.true(isNetworkProtocolError(aggregateError));
  t.true(isTransientRetryableError(aggregateError));

  // - Cyclic .cause → does not hang
  const cyclicError = new Error('Cyclic error');
  (cyclicError as any).cause = cyclicError;
  t.false(isNetworkProtocolError(cyclicError));
  t.false(isTransientRetryableError(cyclicError));

  // - 3-level deep cause chain → correctly classified
  const deepError = new Error('Outer');
  const midError = new Error('Mid');
  const innerError = new Error('Inner');
  (innerError as any).code = 'ECONNREFUSED';
  (midError as any).cause = innerError;
  (deepError as any).cause = midError;
  t.true(isNetworkProtocolError(deepError));
  t.true(isTransientRetryableError(deepError));

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
    t.is(isTransientRetryableError(c), isRetryableTransportError(c).retryable);
  }
});

test('isNetworkProtocolError and isTransientRetryableError findings regression tests', (t) => {
  // P1: Status/authentication rejection precedence
  const authRejectionError = new Error('unexpected server response: 401');
  (authRejectionError as any).cause = { code: 'ETIMEDOUT' };
  t.false(isNetworkProtocolError(authRejectionError));
  t.false(isTransientRetryableError(authRejectionError));

  // P1: Wrapped WebSocket messages, InvalidStateError, and undici stack signals in cause
  const wrappedWsError = new Error('Wrapper');
  (wrappedWsError as any).cause = new Error('Responses websocket connection closed before opening.');
  t.true(isNetworkProtocolError(wrappedWsError));
  t.true(isTransientRetryableError(wrappedWsError));

  const wrappedInvalidState = new Error('Wrapper');
  (wrappedInvalidState as any).cause = { name: 'InvalidStateError', message: 'Socket is closing' };
  t.true(isNetworkProtocolError(wrappedInvalidState));
  t.true(isTransientRetryableError(wrappedInvalidState));

  const undiciSocketClose = new TypeError();
  undiciSocketClose.stack = [
    'TypeError',
    '    at #onSocketClose (node:internal/deps/undici/undici:15450:20)',
    '    at TLSSocket.onSocketClose (node:internal/deps/undici/undici:15153:72)',
    '    at TLSSocket.emit (node:events:520:35)',
  ].join('\n');
  const wrappedUndici = new Error('Wrapper');
  (wrappedUndici as any).cause = undiciSocketClose;
  t.true(isNetworkProtocolError(wrappedUndici));
  t.true(isTransientRetryableError(wrappedUndici));

  // P2: Restored message signals
  const socketHangup = new Error('socket hang up');
  t.true(isNetworkProtocolError(socketHangup));
  t.true(isTransientRetryableError(socketHangup));

  const connFailed = new Error('connection failed');
  t.true(isNetworkProtocolError(connFailed));
  t.true(isTransientRetryableError(connFailed));

  const failedToOpen = new Error('failed to open');
  t.true(isNetworkProtocolError(failedToOpen));
  t.true(isTransientRetryableError(failedToOpen));

  const connError = new Error('connection error');
  t.true(isNetworkProtocolError(connError));
  t.true(isTransientRetryableError(connError));
});
