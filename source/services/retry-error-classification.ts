import { APIConnectionError, APIConnectionTimeoutError, InternalServerError, RateLimitError } from 'openai';
import { OpenAICompatibleError, OpenRouterError } from '../providers/common/provider-errors.js';

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

const getMessage = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? '');
  }
  return '';
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

const isRetryableAbnormalCloseError = (error: unknown): boolean => {
  const message = getMessage(error).toLowerCase();
  return message.includes('websocket connection closed before response completed') && message.includes('code=1006');
};

export const isRetryableTransportError = (error: unknown): RetryableTransportDecision => {
  const retryable =
    isFirstFrameTimeoutError(error) || isRetryableAbnormalCloseError(error) || isNetworkProtocolError(error);
  return {
    retryable,
    transportFallback: retryable && isNetworkProtocolError(error),
  };
};

/**
 * Returns true when the error is a transient upstream failure (429 / 5xx /
 * connection timeout) that is worth retrying automatically.
 */
export const isTransientRetryableError = (error: unknown): boolean => {
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

    const message = getMessage(error).toLowerCase();
    if (message.includes('websocket connection closed before response completed')) {
      const closeCode = message.match(/code=(\d+)/)?.[1];
      return closeCode ? closeCode === '1006' : true;
    }

    if (
      message.includes("expecting ',' delimiter") ||
      message.includes('unexpected end of json') ||
      message.includes('is not valid json') ||
      (message.includes('json') && (message.includes('unexpected') || message.includes('expected')))
    ) {
      return true;
    }

    if (
      message.includes('rate limit') ||
      message.includes('too many requests') ||
      message.includes('rate_limit') ||
      message === 'terminated' ||
      message.startsWith('terminated:')
    ) {
      return true;
    }
  }

  return false;
};
