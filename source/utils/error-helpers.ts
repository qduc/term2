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
		const message =
			typeof err.message === 'string'
				? err.message
				: error instanceof Error
					? error.message
					: '';
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

	return abortPatterns.some(pattern => pattern.test(errorMessage));
};

