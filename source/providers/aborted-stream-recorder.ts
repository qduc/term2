import type {
  ProviderTrafficStreamDiagnostics,
  ProviderTrafficBoundedStreamDiagnostics,
  ProviderTrafficProgressCategory,
} from '../services/service-interfaces.js';

/**
 * Fixed, bounded set of progress categories a WebSocket Responses frame can be
 * classified into. This is deliberately a closed union (5 keys) rather than
 * the raw event `type` string: a failure-side reader without wire knowledge
 * cannot tell from `eventTypeCounts` alone whether a stalled or truncated
 * stream was making text, reasoning, or tool-call progress, saw usage
 * accounting, or was idle on heartbeat/unrecognized frames. Categorization
 * never inspects payload content — only the frame's `type` string and the
 * presence of a `usage` field — so it adds no sensitive data and no unbounded
 * cardinality.
 *
 * This is also why `boundedDiagnostics()` below reports only these five
 * counters and not `eventTypeCounts`: the raw `type` string of a wire frame
 * is provider-supplied text with no enforced vocabulary, so a hostile or
 * novel frame could grow that map's key set or content without limit. The
 * fixed-category counts are the only per-frame breakdown safe to put in a
 * mechanically bounded view.
 */
const classifyProgressCategory = (event: unknown, type: string): ProviderTrafficProgressCategory => {
  if (event && typeof event === 'object') {
    const record = event as { usage?: unknown; response?: { usage?: unknown } };
    if (record.usage !== undefined || record.response?.usage !== undefined) return 'usage';
  }
  if (type.includes('output_text')) return 'text';
  if (type.includes('reasoning') || type.includes('summary')) return 'reasoning';
  if (type.includes('function_call') || type.includes('tool')) return 'tool';
  return 'heartbeat_or_unknown';
};

const emptyProgressCategoryCounts = (): Record<ProviderTrafficProgressCategory, number> => ({
  text: 0,
  reasoning: 0,
  tool: 0,
  usage: 0,
  heartbeat_or_unknown: 0,
});

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
  readonly #progressCategoryCounts: Record<ProviderTrafficProgressCategory, number> = emptyProgressCategoryCounts();
  #events: unknown[] | undefined = [];
  #firstEventMs: number | undefined;
  #lastEventMs: number | undefined;
  #maxGapMs = 0;
  #responseId: string | undefined;
  #sawFailureFrame = false;
  #closeCode: number | undefined;
  #closeReason: string | undefined;
  #eventCount = 0;
  #toolArgumentDeltaFrames = 0;
  #toolArgumentDeltaCharacters = 0;
  #toolCallStartFrames = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#startedAtMs = now();
  }

  observe(event: unknown): void {
    this.#eventCount += 1;
    const elapsed = this.#now() - this.#startedAtMs;
    if (this.#firstEventMs === undefined) this.#firstEventMs = elapsed;
    else this.#maxGapMs = Math.max(this.#maxGapMs, elapsed - (this.#lastEventMs ?? 0));
    this.#lastEventMs = elapsed;

    const type = typeof (event as { type?: unknown })?.type === 'string' ? (event as { type: string }).type : 'unknown';
    this.#eventTypeCounts[type] = (this.#eventTypeCounts[type] ?? 0) + 1;

    const category = classifyProgressCategory(event, type);
    this.#progressCategoryCounts[category] += 1;

    if (isToolArgumentDeltaType(type)) {
      this.#toolArgumentDeltaFrames += 1;
      const delta = (event as { delta?: unknown }).delta;
      if (typeof delta === 'string') this.#toolArgumentDeltaCharacters += delta.length;
    } else if (isToolCallStart(event, type)) {
      this.#toolCallStartFrames += 1;
    }

    // A raw transport-level `error` or `close` frame (as opposed to a Responses
    // API `response.failed` event) means the underlying WebSocket ended the
    // exchange itself. The consumer that reads this recorder's output only
    // learns that later, once it decides to stop reading and `.return()`s the
    // generator this recorder is attached to — at which point the frame that
    // explains why is long gone unless captured here.
    if (type === 'error' || type === 'close') {
      this.#sawFailureFrame = true;
      const record = event as { code?: unknown; reason?: unknown };
      if (typeof record?.code === 'number') this.#closeCode = record.code;
      if (typeof record?.reason === 'string' && record.reason) this.#closeReason = record.reason;
    }

    const responseId = readResponseId(event);
    if (responseId) this.#responseId = responseId;

    this.#events?.push(event);
  }

  /**
   * True once a raw `error`/`close` transport frame has been observed. The
   * caller uses this to classify an early `.return()` as an explained failure
   * rather than an ordinary consumer-initiated stop.
   */
  sawFailureFrame(): boolean {
    return this.#sawFailureFrame;
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
      ...(this.#closeCode !== undefined ? { closeCode: this.#closeCode } : {}),
      ...(this.#closeReason !== undefined ? { closeReason: this.#closeReason } : {}),
      eventTypeCounts: { ...this.#eventTypeCounts },
      progressCategoryCounts: { ...this.#progressCategoryCounts },
      toolArgumentDeltaFrames: this.#toolArgumentDeltaFrames,
      toolArgumentDeltaCharacters: this.#toolArgumentDeltaCharacters,
      toolCallStartFrames: this.#toolCallStartFrames,
      events: this.#events ? [...this.#events] : [],
    };
  }

  /**
   * A mechanically bounded view for callers that must not retain unbounded or
   * provider-supplied text — in particular a genuine transport failure, which
   * can carry tens of thousands of frames and, unlike a deliberate client
   * abort, is not a case where replaying the exact payload is the point.
   *
   * Every field here has a fixed size regardless of what the wire sends:
   * `progressCategoryCounts` has exactly five fixed keys; event, timing, and
   * tool-argument growth fields are single numbers; and `closeCode` is a numeric WebSocket
   * close code (RFC 6455 §7.4 is a 16-bit integer, not free text). Deliberately
   * excluded, unlike {@link diagnostics}: `eventTypeCounts` (its keys are raw
   * provider `type` strings with no enforced vocabulary or length — a hostile
   * or novel frame stream could grow it without limit), the raw `events`
   * transcript, `closeReason` (free-text the server chooses), and `responseId`
   * (a provider-issued opaque string, kept out here on the same "no
   * unbounded/free-form provider text" principle even though a single ID is
   * small in practice).
   */
  boundedDiagnostics(): ProviderTrafficBoundedStreamDiagnostics {
    return {
      durationMs: this.#now() - this.#startedAtMs,
      ...(this.#firstEventMs === undefined ? {} : { firstEventMs: this.#firstEventMs }),
      ...(this.#lastEventMs === undefined ? {} : { lastEventMs: this.#lastEventMs }),
      ...(this.#firstEventMs === undefined ? {} : { maxGapMs: this.#maxGapMs }),
      ...(this.#closeCode !== undefined ? { closeCode: this.#closeCode } : {}),
      eventCount: this.#eventCount,
      progressCategoryCounts: { ...this.#progressCategoryCounts },
      toolArgumentDeltaFrames: this.#toolArgumentDeltaFrames,
      toolArgumentDeltaCharacters: this.#toolArgumentDeltaCharacters,
      toolCallStartFrames: this.#toolCallStartFrames,
    };
  }
}

const TOOL_ARGUMENT_DELTA_TYPES = new Set([
  'response.function_call_arguments.delta',
  'response.custom_tool_call_input.delta',
  'response.mcp_call_arguments.delta',
]);

function isToolArgumentDeltaType(type: string): boolean {
  return TOOL_ARGUMENT_DELTA_TYPES.has(type);
}

function isToolCallStart(event: unknown, type: string): boolean {
  if (type !== 'response.output_item.added' || !event || typeof event !== 'object') return false;
  const record = event as { output_item?: { type?: unknown }; item?: { type?: unknown } };
  const itemType = (record.output_item ?? record.item)?.type;
  return itemType === 'function_call' || itemType === 'custom_tool_call';
}

function readResponseId(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as { response?: { id?: unknown }; response_id?: unknown };
  if (typeof record.response_id === 'string' && record.response_id.length > 0) return record.response_id;
  const nested = record.response?.id;
  return typeof nested === 'string' && nested.length > 0 ? nested : undefined;
}
