/**
 * Recovery when an endpoint refuses a request that carries a cache-preserving effort change.
 *
 * The in-history item is the plausible cause of an invalid-request rejection that arrives before
 * any output, so the request is sent once more without it, the effective effort top-level. The
 * rejection is recorded (by the host, through `EffortUpdatesRejection`) as soon as the retry is
 * decided, whatever the retry's outcome, and every later request reads the same record: the
 * registry asks `rejected()` instead of keeping a flag, so it holds across registry rebuilds
 * and resume. A rejection that arrives after output has started is neither retried nor recorded.
 */
import type { ILoggingService } from '../shared/service-interfaces.js';
import { toModelFailure } from './failure.js';
import { isEffortUpdateItem } from './effort-updates.js';
import type { ModelEvent, ModelRef, ModelRequest } from './index.js';
import type { ResponseContinuation } from './providers/runtime/model-events.js';

/** The host's per-session record of a refused marker. `rejected()` must read what `record()` wrote. */
export type EffortUpdatesRejection = {
  rejected(): boolean;
  record(): void;
};

/** The levels a request may use markers for: none once this session has seen the endpoint refuse one. */
export function activeEffortLevels(
  declared: readonly string[] | undefined,
  rejection: EffortUpdatesRejection | undefined,
): readonly string[] | undefined {
  return declared && !rejection?.rejected() ? declared : undefined;
}

/** A request holds an effort change if it has a marker or a carried conversation effort. */
function carriesEffort(request: ModelRequest): boolean {
  return (
    request.input.some(isEffortUpdateItem) ||
    (request.continuation as Partial<ResponseContinuation> | undefined)?.effort !== undefined
  );
}

export async function* withEffortFallback(input: {
  readonly request: ModelRequest;
  readonly signal: AbortSignal;
  readonly ref: ModelRef;
  readonly logger: ILoggingService;
  readonly rejection: EffortUpdatesRejection | undefined;
  readonly levels: readonly string[] | undefined;
  /** One physical attempt; `undefined` levels is today's request. */
  readonly attempt: (levels: readonly string[] | undefined) => AsyncIterable<ModelEvent>;
}): AsyncGenerator<ModelEvent, void> {
  const { request, signal, ref, logger, rejection, levels, attempt } = input;
  let produced = false;
  try {
    for await (const event of attempt(levels)) {
      produced = true;
      yield event;
    }
  } catch (error) {
    const failure = toModelFailure(error, signal);
    if (!levels || !carriesEffort(request) || produced || signal.aborted || failure.kind !== 'invalid_request')
      throw failure;
    if (request.recovery && !request.recovery.budget.claimPhysicalAttempt()) throw failure;
    rejection?.record();
    logger.warn('Endpoint rejected a cache-preserving effort change; continuing with top-level effort', {
      provider: ref.provider,
      model: ref.model,
      error: failure.message,
    });
    yield* attempt(undefined);
  }
}
