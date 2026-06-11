import test from 'ava';
import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import { ModelBehaviorError } from '@openai/agents';
import { OpenAICompatibleError, OpenRouterError } from '../providers/common/provider-errors.js';
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
});
