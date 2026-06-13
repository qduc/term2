import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import { OpenAICompatibleError, OpenRouterError } from '../../providers/common/provider-errors.js';
import type { ILoggingService } from '../service-interfaces.js';

export type RetryableTransportDecision = {
  retryable: boolean;
  transportFallback: boolean;
};

const TRANSIENT_SYSTEM_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const UNDICI_RETRYABLE_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

// WebSocket close codes that indicate temporary conditions worth retrying.
// Keep all retryable codes in one place.
const RETRYABLE_WEBSOCKET_CLOSE_CODES = new Set([
  '1001', // Going Away — server shutdown, may come back
  '1006', // Abnormal Close — network drop, no close frame
  '1011', // Internal Error — server hit unexpected condition
  '1012', // Service Restart — server is restarting
  '1013', // Try Again Later — server overloaded
]);

const extractWebSocketCloseCode = (message: string): string | undefined => {
  const match = message.match(/code[=\s](\d+)/);
  return match?.[1];
};

const getMessage = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? '');
  }
  return '';
};

export function isPreviousResponseNotFoundError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || seen.has(error)) return false;
  seen.add(error);

  if (typeof error === 'string') {
    return /["']?code["']?\s*:\s*["']previous_response_not_found["']/.test(error);
  }
  if (typeof error !== 'object') return false;

  const value = error as Record<string, unknown>;
  if (value.code === 'previous_response_not_found') return true;
  if (isPreviousResponseNotFoundError(value.message, seen)) return true;
  if (isPreviousResponseNotFoundError(value.body, seen)) return true;
  if (isPreviousResponseNotFoundError(value.error, seen)) return true;
  if (isPreviousResponseNotFoundError(value.cause, seen)) return true;
  return false;
}

const logWebSocketCloseCode = (
  logger: Pick<ILoggingService, 'info'> | undefined,
  error: unknown,
  closeCode: string,
): void => {
  try {
    logger?.info('WebSocket close code detected', {
      eventType: 'retry.websocket_close_code_detected',
      category: 'retry',
      closeCode,
      errorMessage: getMessage(error),
    });
  } catch {
    // Logging should never affect retry classification.
  }
};

function handleWebSocketCloseClassification(
  error: unknown,
  logger?: Pick<ILoggingService, 'info'>,
  seen = new Set<unknown>(),
): boolean | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  if (seen.has(error)) {
    return undefined;
  }
  seen.add(error);

  const message = getMessage(error);
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes('websocket connection closed') || lowerMessage.includes('websocket closed')) {
    const closeCode = extractWebSocketCloseCode(message);
    if (closeCode) {
      logWebSocketCloseCode(logger, error, closeCode);
    }
    return closeCode ? RETRYABLE_WEBSOCKET_CLOSE_CODES.has(closeCode) : true;
  }

  if (Array.isArray((error as any).errors)) {
    for (const subError of (error as any).errors) {
      const result = handleWebSocketCloseClassification(subError, logger, seen);
      if (result !== undefined) {
        return result;
      }
    }
  }

  if ((error as any).cause) {
    const result = handleWebSocketCloseClassification((error as any).cause, logger, seen);
    if (result !== undefined) {
      return result;
    }
  }

  return undefined;
}

/**
 * Undici's HTTP / WebSocket body parser throws a bare `new TypeError()`
 * (empty message, no `code`, no `cause`) when the TLS socket closes
 * mid-response-body. The only reliable signal is the stack: the private
 * `#onSocketClose` frame in `node:internal/deps/undici/undici`. Detect
 * that pattern explicitly so we can classify it as a transient transport
 * error instead of an unrecoverable programmer-error TypeError.
 *
 * Intermediate layers (SDK wrappers, stream collectors) may re-wrap the
 * original TypeError into a plain `Error` with `message: "TypeError"` and
 * the original undici stack frames. We handle both the canonical bare
 * TypeError form and the re-wrapped form by checking the stack pattern
 * as the primary signal, with name/message guards to avoid false positives
 * from unrelated errors that happen to have `onSocketClose` in their stack.
 */
export function isUndiciSocketCloseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { name?: unknown; message?: unknown; stack?: unknown };
  const stack = typeof err.stack === 'string' ? err.stack : '';
  if (!stack.includes('onSocketClose') || !stack.includes('undici')) return false;

  const name = typeof err.name === 'string' ? err.name : '';
  const message = typeof err.message === 'string' ? err.message.trim() : '';

  if (name === 'TypeError' && message.length === 0) return true;

  if ((name === 'Error' || name === 'TypeError') && (message.length === 0 || message === 'TypeError')) return true;

  return false;
}

export function isNetworkProtocolError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error) return false;

  if (seen.has(error)) {
    return false;
  }
  seen.add(error);

  // 1. Explicit status/authentication rejection takes precedence over cause checks.
  const message = getMessage(error).toLowerCase();
  if (
    message.includes('unexpected server response: 401') ||
    message.includes('unexpected server response: 403') ||
    message.includes('unexpected server response: 429')
  ) {
    return false;
  }

  const unexpectedServerResponseMatch = message.match(/unexpected server response:\s*(\d{3})/);
  if (unexpectedServerResponseMatch) {
    const status = Number(unexpectedServerResponseMatch[1]);
    if (status !== 502 && status !== 503 && status !== 504 && status !== 520) {
      return false;
    }
  }

  // 2. Structured code/class checks
  if (error instanceof APIConnectionError || error instanceof APIConnectionTimeoutError) {
    return true;
  }

  if (typeof (error as any).code === 'string') {
    const code = (error as any).code.toUpperCase();
    if (TRANSIENT_SYSTEM_ERROR_CODES.has(code) || UNDICI_RETRYABLE_CODES.has(code)) {
      return true;
    }
  }

  if (error && typeof error === 'object') {
    const statusRaw = (error as any).status ?? (error as any).statusCode;
    const status = typeof statusRaw === 'number' ? statusRaw : parseInt(statusRaw, 10);
    if (status === 520) {
      return true;
    }
  }

  // 3. String message patterns (including restored generic and WebSocket ones)
  if (
    message.includes('websocket connection closed') ||
    message.includes('websocket is not open') ||
    message.includes('websocket open timed out') ||
    message.includes('websocket idle timeout') ||
    message.includes('websocket first frame timeout') ||
    message.includes('timed out before opening') ||
    message.includes('websocket connection timed out') ||
    message.includes('pong timeout') ||
    message.includes('unexpected server response:') || // 502/503/504/520 passed above
    message.includes('connection timed out') ||
    message.includes('socket hang up') ||
    message.includes('failed to open') ||
    message.includes('connection error') ||
    message.includes('connection failed') ||
    message.includes('520 status code') ||
    message.includes('status code 520')
  ) {
    return true;
  }

  if ((error as any).name === 'InvalidStateError') {
    return true;
  }

  if (isUndiciSocketCloseError(error)) {
    return true;
  }

  // 4. Recursive checks
  if (Array.isArray((error as any).errors)) {
    for (const subError of (error as any).errors) {
      if (isNetworkProtocolError(subError, seen)) {
        return true;
      }
    }
  }

  if ((error as any).cause) {
    if (isNetworkProtocolError((error as any).cause, seen)) {
      return true;
    }
  }

  return false;
}

const isFirstFrameTimeoutError = (error: unknown): boolean =>
  getMessage(error).toLowerCase().includes('websocket first frame timeout');

const isRetryableAbnormalCloseError = (error: unknown, logger?: Pick<ILoggingService, 'info'>): boolean => {
  const message = getMessage(error).toLowerCase();
  if (!message.includes('websocket connection closed before response completed')) {
    return false;
  }
  const closeCode = extractWebSocketCloseCode(message);
  if (closeCode) {
    logWebSocketCloseCode(logger, error, closeCode);
  }
  return closeCode ? RETRYABLE_WEBSOCKET_CLOSE_CODES.has(closeCode) : true;
};

export const isRetryableTransportError = (
  error: unknown,
  logger?: Pick<ILoggingService, 'info'>,
): RetryableTransportDecision => {
  const retryable =
    isPreviousResponseNotFoundError(error) ||
    isFirstFrameTimeoutError(error) ||
    isRetryableAbnormalCloseError(error, logger) ||
    isNetworkProtocolError(error);
  return {
    retryable,
    transportFallback: retryable && isNetworkProtocolError(error),
  };
};

/**
 * Returns true when the error is a transient upstream failure (429 / 5xx /
 * connection timeout) that is worth retrying automatically.
 */
export const isTransientRetryableError = (error: unknown, logger?: Pick<ILoggingService, 'info'>): boolean => {
  if (
    error instanceof APIConnectionError ||
    error instanceof APIConnectionTimeoutError ||
    error instanceof InternalServerError ||
    error instanceof RateLimitError
  ) {
    return true;
  }

  if (isUndiciSocketCloseError(error)) {
    return true;
  }

  if (error instanceof OpenRouterError && (error.status === 429 || error.status >= 500)) {
    return true;
  }
  if (error instanceof OpenRouterError) {
    return false;
  }

  if (error instanceof OpenAICompatibleError && (error.status === 429 || error.status >= 500)) {
    return true;
  }
  if (error instanceof OpenAICompatibleError) {
    return false;
  }

  if (typeof error === 'string') {
    const lower = error.toLowerCase();
    if (lower === 'terminated' || lower.startsWith('terminated:')) {
      return true;
    }
  }

  if (error && typeof error === 'object') {
    const statusRaw = (error as any).status ?? (error as any).statusCode;
    const status = typeof statusRaw === 'number' ? statusRaw : parseInt(statusRaw, 10);
    if (Number.isInteger(status)) {
      if (status === 429 || status >= 500) {
        return true;
      }
      return false;
    }
  }

  // 1. WebSocket abnormal close code classification (with logging)
  const wsResult = handleWebSocketCloseClassification(error, logger);
  if (wsResult !== undefined) {
    return wsResult;
  }

  // 2. Network protocol errors
  if (isNetworkProtocolError(error)) {
    return true;
  }

  // 3. String message patterns
  if (error && typeof error === 'object') {
    const message = getMessage(error);
    const lowerMessage = message.toLowerCase();

    if (
      lowerMessage.includes("expecting ',' delimiter") ||
      lowerMessage.includes('unexpected end of json') ||
      lowerMessage.includes('is not valid json') ||
      (lowerMessage.includes('json') && (lowerMessage.includes('unexpected') || lowerMessage.includes('expected')))
    ) {
      return true;
    }

    if (
      lowerMessage.includes('rate limit') ||
      lowerMessage.includes('too many requests') ||
      lowerMessage.includes('rate_limit') ||
      lowerMessage === 'terminated' ||
      lowerMessage.startsWith('terminated:')
    ) {
      return true;
    }
  }

  return false;
};
