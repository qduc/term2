import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import {
  OpenAICompatibleError,
  OpenRouterError,
  LongRetryDelayError,
  findReauthenticationRequiredError,
} from '../../providers/common/provider-errors.js';
import { getRetryAfterMs } from './upstream-retry-policy.js';
import type { ILoggingService } from '../service-interfaces.js';
import { AmbiguousModelOutcomeError } from './retry-errors.js';

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
    return (
      /["']?code["']?\s*:\s*["']previous_response_not_found["']/.test(error) ||
      /invalid\s+[`'"]?previous_response_id[`'"]?/i.test(error)
    );
  }
  if (typeof error !== 'object') return false;

  const value = error as Record<string, unknown>;
  if (value.code === 'previous_response_not_found') return true;
  if (typeof value.message === 'string' && /invalid\s+[`'"]?previous_response_id[`'"]?/i.test(value.message)) {
    return true;
  }
  if (isPreviousResponseNotFoundError(value.message, seen)) return true;
  if (isPreviousResponseNotFoundError(value.body, seen)) return true;
  if (isPreviousResponseNotFoundError(value.error, seen)) return true;
  if (isPreviousResponseNotFoundError(value.cause, seen)) return true;
  return false;
}

/**
 * Server rejected a chained request because its function calls and outputs no
 * longer match. Same recovery class as previous_response_not_found: drop the
 * chain and replay full history, whose provider adapter removes orphan outputs.
 */
export function isMissingServerToolOutputError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || seen.has(error)) return false;
  seen.add(error);

  if (typeof error === 'string') {
    return /no tool (?:output found for function call|call found for function call output)/i.test(error);
  }
  if (typeof error !== 'object') return false;

  const value = error as Record<string, unknown>;
  if (
    typeof value.message === 'string' &&
    /no tool (?:output found for function call|call found for function call output)/i.test(value.message)
  ) {
    return true;
  }
  if (isMissingServerToolOutputError(value.message, seen)) return true;
  if (isMissingServerToolOutputError(value.body, seen)) return true;
  if (isMissingServerToolOutputError(value.error, seen)) return true;
  if (isMissingServerToolOutputError(value.cause, seen)) return true;
  return false;
}

export function isWebSocketConnectionLimitReachedError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || seen.has(error)) return false;
  seen.add(error);

  if (typeof error === 'string') {
    return error.toLowerCase().includes('websocket_connection_limit_reached');
  }
  if (typeof error !== 'object') return false;

  const value = error as Record<string, unknown>;
  if (value.code === 'websocket_connection_limit_reached') return true;
  if (isWebSocketConnectionLimitReachedError(value.message, seen)) return true;
  if (isWebSocketConnectionLimitReachedError(value.body, seen)) return true;
  if (isWebSocketConnectionLimitReachedError(value.error, seen)) return true;
  if (isWebSocketConnectionLimitReachedError(value.cause, seen)) return true;
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
  if (!error || error instanceof AmbiguousModelOutcomeError) return false;

  // Only a human re-login clears this, so no amount of retrying helps. It
  // reaches here disguised as `APIConnectionError('Connection error.')`
  // because the SDK wraps whatever the fetch impl throws.
  if (findReauthenticationRequiredError(error)) return false;

  if (seen.has(error)) {
    return false;
  }
  seen.add(error);

  // The Responses WebSocket has a provider-enforced maximum lifetime. Once
  // reached, the current connection and its server-managed response chain must
  // be replaced even though the provider reports the condition as a 400.
  if (isWebSocketConnectionLimitReachedError(error)) {
    return true;
  }

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
    message.includes('websocket was closed before the connection was established') ||
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

/**
 * Provider adapters refuse to invent a completion when the stream body ends
 * without a terminal marker (`finish_reason`, AI-SDK finish event, Responses
 * `response.completed`, …). That is the right refusal — the body was cut
 * short — but the cut itself is usually a flaky upstream close, so the run
 * should retry rather than terminate.
 *
 * Matched phrases:
 * - "streamed response ended without" (HTTP/SSE incomplete body)
 * - "closed before a terminal response event" (Codex/OpenAI WebSocket close
 *   before response.completed / failed / incomplete)
 */
export function isIncompleteStreamTerminalError(error: unknown): boolean {
  const message = getMessage(error).toLowerCase();
  return (
    message.includes('streamed response ended without') || message.includes('closed before a terminal response event')
  );
}

/**
 * Whether an incomplete stream terminal is worth recovering from.
 *
 * `isRetryableTransportError` refuses every `AmbiguousModelOutcomeError`,
 * because replaying a request the server may already have accepted is unsafe
 * *against the same chain*. Rebuilding from full history is not a replay, so
 * this predicate exists for the caller that can break chaining first.
 *
 * A close code is the only evidence that separates a flaky drop from a
 * deliberate server close. When the code is absent — an HTTP/SSE body that
 * simply stopped, or a close frame that carried none — there is nothing
 * pointing at a deliberate rejection, so recovery is allowed.
 */
export const isRecoverableIncompleteStreamClose = (error: unknown, logger?: Pick<ILoggingService, 'info'>): boolean => {
  if (!isIncompleteStreamTerminalError(error)) return false;
  const closeCode = extractWebSocketCloseCode(getMessage(error));
  if (closeCode) {
    logWebSocketCloseCode(logger, error, closeCode);
    return RETRYABLE_WEBSOCKET_CLOSE_CODES.has(closeCode);
  }
  return true;
};

export const isRetryableTransportError = (
  error: unknown,
  logger?: Pick<ILoggingService, 'info'>,
): RetryableTransportDecision => {
  if (error instanceof AmbiguousModelOutcomeError) {
    return { retryable: false, transportFallback: false };
  }

  if (findReauthenticationRequiredError(error)) {
    return { retryable: false, transportFallback: false };
  }

  // Incomplete terminals are retryable but not a network-protocol class: keep
  // transportFallback false so Codex does not force an HTTP/WS switch.
  if (isIncompleteStreamTerminalError(error)) {
    return { retryable: true, transportFallback: false };
  }

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
  // Rate-limit with retry-after > 60s — never retry automatically
  if (error instanceof LongRetryDelayError) {
    return false;
  }

  // An expired or absent credential is not transient.
  if (findReauthenticationRequiredError(error)) {
    return false;
  }

  // Incomplete stream terminals (finish_reason / finish event missing) are
  // recoverable mid-stream cuts — same policy as isRetryableTransportError.
  if (isIncompleteStreamTerminalError(error)) {
    return true;
  }

  if (error instanceof RateLimitError) {
    const retryAfterMs = getRetryAfterMs(error);
    return retryAfterMs === undefined || retryAfterMs <= 60_000;
  }

  if (
    error instanceof APIConnectionError ||
    error instanceof APIConnectionTimeoutError ||
    error instanceof InternalServerError
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
