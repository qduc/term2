import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import { OpenAICompatibleError, OpenRouterError } from '../providers/common/provider-errors.js';
import type { ILoggingService } from './service-interfaces.js';

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

export function isNetworkProtocolError(error: unknown): boolean {
  if (!error) return false;

  if (typeof (error as any).code === 'string') {
    const code = (error as any).code.toUpperCase();
    if (TRANSIENT_SYSTEM_ERROR_CODES.has(code)) {
      return true;
    }
  }

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
    return status === 502 || status === 503 || status === 504;
  }

  if (
    message.includes('websocket connection closed') ||
    message.includes('websocket is not open') ||
    message.includes('websocket open timed out') ||
    message.includes('websocket idle timeout') ||
    message.includes('websocket first frame timeout') ||
    message.includes('timed out before opening') ||
    message.includes('connection timed out') ||
    message.includes('socket hang up') ||
    message.includes('pong timeout') ||
    message.includes('unexpected server response:') ||
    message.includes('failed to open') ||
    message.includes('connection error') ||
    message.includes('connection failed')
  ) {
    return true;
  }

  if ((error as any).name === 'InvalidStateError') {
    return true;
  }

  if ((error as any).cause && isNetworkProtocolError((error as any).cause)) {
    return true;
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
    isFirstFrameTimeoutError(error) || isRetryableAbnormalCloseError(error, logger) || isNetworkProtocolError(error);
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

  if (error instanceof OpenRouterError && (error.status === 429 || error.status >= 500)) {
    return true;
  }

  if (error instanceof OpenAICompatibleError && (error.status === 429 || error.status >= 500)) {
    return true;
  }

  if (typeof error === 'string') {
    const lower = error.toLowerCase();
    if (lower === 'terminated' || lower.startsWith('terminated:')) {
      return true;
    }
  }

  if (error && typeof error === 'object') {
    if ((error as any).name === 'ChainingTransportDowngradeError') {
      return true;
    }

    const statusRaw = (error as any).status ?? (error as any).statusCode;
    const status = typeof statusRaw === 'number' ? statusRaw : parseInt(statusRaw, 10);
    if (Number.isInteger(status) && (status === 429 || status >= 500)) {
      return true;
    }

    const message = getMessage(error);
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes('websocket connection closed') || lowerMessage.includes('websocket closed')) {
      const closeCode = extractWebSocketCloseCode(message);
      if (closeCode) {
        logWebSocketCloseCode(logger, error, closeCode);
      }
      return closeCode ? RETRYABLE_WEBSOCKET_CLOSE_CODES.has(closeCode) : true;
    }

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
