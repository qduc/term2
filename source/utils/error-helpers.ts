const GENERIC_ERROR_MESSAGES = new Set([
  'fetch failed',
  'failed to fetch',
  'network error',
  'request failed',
  'terminated',
]);

const getOwnErrorMessage = (error: unknown): string | null => {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  }

  return null;
};

const collectErrorMessages = (error: unknown, seen = new Set<unknown>()): string[] => {
  if (!error || seen.has(error)) {
    return [];
  }

  if (typeof error === 'object' || typeof error === 'function') {
    seen.add(error);
  }

  const messages: string[] = [];
  const ownMessage = getOwnErrorMessage(error);
  if (ownMessage) {
    messages.push(ownMessage);
  }

  if (typeof error === 'object' && error !== null) {
    const maybeAggregate = error as { errors?: unknown[]; cause?: unknown };
    if (Array.isArray(maybeAggregate.errors)) {
      for (const nested of maybeAggregate.errors) {
        messages.push(...collectErrorMessages(nested, seen));
      }
    }
    if (maybeAggregate.cause && maybeAggregate.cause !== error) {
      messages.push(...collectErrorMessages(maybeAggregate.cause, seen));
    }
  }

  return messages.filter((message, index, array) => array.indexOf(message) === index);
};

export const describeError = (error: unknown): string => {
  const messages = collectErrorMessages(error);
  if (messages.length === 0) {
    return String(error);
  }

  if (messages.length === 1) {
    return messages[0]!;
  }

  const [firstMessage, ...rest] = messages;
  if (GENERIC_ERROR_MESSAGES.has(firstMessage.toLowerCase())) {
    return `${firstMessage}: ${rest[0]}`;
  }

  return firstMessage;
};

/**
 * Check if an error is abort-related (user-initiated cancellation / AbortController).
 * These errors should generally not be surfaced to the user.
 */
export const isAbortLikeError = (error: unknown): boolean => {
  if (!error) return false;

  // Recurse into common wrapper shapes first (keeps outer-message quirks from leaking)
  if (typeof error === 'object' && error !== null) {
    const err = error as any;

    // Standard abort signals
    if (err.name === 'AbortError') return true;
    if (err.code === 'ABORT_ERR') return true;

    // Undici/Node fetch can surface aborts as `TypeError: terminated`
    // with the abort reason stored in `cause`.
    const message = typeof err.message === 'string' ? err.message : error instanceof Error ? error.message : '';
    if (message.toLowerCase() === 'terminated' && err.cause) {
      return isAbortLikeError(err.cause);
    }

    // AggregateError / multi-error wrappers
    if (Array.isArray(err.errors) && err.errors.some(isAbortLikeError)) {
      return true;
    }

    if (err.cause && err.cause !== error) {
      if (isAbortLikeError(err.cause)) return true;
    }
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const abortPatterns = [
    /abort/i,
    /cancel/i,
    /user.?cancelled/i,
    /user.?aborted/i,
    /operation.?aborted/i,
    /operation.?cancelled/i,
  ];

  return abortPatterns.some((pattern) => pattern.test(errorMessage));
};
