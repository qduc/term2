import type { ProviderTrafficStreamDiagnostics } from '../services/service-interfaces.js';

/**
 * Retains a streaming response so a stream that ends without a terminal event
 * can still be explained afterwards.
 *
 * A completed response is summarized from its payload, but an aborted one has
 * no payload at all — previously only an event count survived, which cannot
 * distinguish a runaway generation from a stalled socket. The transcript is
 * held only until a terminal event arrives, at which point it is redundant and
 * dropped.
 */
export class AbortedStreamRecorder {
  readonly #now: () => number;
  readonly #startedAtMs: number;
  readonly #eventTypeCounts: Record<string, number> = {};
  #events: unknown[] | undefined = [];
  #firstEventMs: number | undefined;
  #lastEventMs: number | undefined;
  #maxGapMs = 0;
  #responseId: string | undefined;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#startedAtMs = now();
  }

  observe(event: unknown): void {
    const elapsed = this.#now() - this.#startedAtMs;
    if (this.#firstEventMs === undefined) this.#firstEventMs = elapsed;
    else this.#maxGapMs = Math.max(this.#maxGapMs, elapsed - (this.#lastEventMs ?? 0));
    this.#lastEventMs = elapsed;

    const type = typeof (event as { type?: unknown })?.type === 'string' ? (event as { type: string }).type : 'unknown';
    this.#eventTypeCounts[type] = (this.#eventTypeCounts[type] ?? 0) + 1;

    const responseId = readResponseId(event);
    if (responseId) this.#responseId = responseId;

    this.#events?.push(event);
  }

  /** Drop the transcript once a terminal event makes it redundant. */
  release(): void {
    this.#events = undefined;
  }

  diagnostics(): ProviderTrafficStreamDiagnostics {
    return {
      durationMs: this.#now() - this.#startedAtMs,
      ...(this.#firstEventMs === undefined ? {} : { firstEventMs: this.#firstEventMs }),
      ...(this.#lastEventMs === undefined ? {} : { lastEventMs: this.#lastEventMs }),
      ...(this.#firstEventMs === undefined ? {} : { maxGapMs: this.#maxGapMs }),
      ...(this.#responseId ? { responseId: this.#responseId } : {}),
      eventTypeCounts: { ...this.#eventTypeCounts },
      events: this.#events ? [...this.#events] : [],
    };
  }
}

function readResponseId(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as { response?: { id?: unknown }; response_id?: unknown };
  if (typeof record.response_id === 'string' && record.response_id.length > 0) return record.response_id;
  const nested = record.response?.id;
  return typeof nested === 'string' && nested.length > 0 ? nested : undefined;
}
