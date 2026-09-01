/**
 * Utility for tracking token streaming speed (tokens per second / TPS).
 *
 * Handles both:
 * 1. Live generation speed during streaming (using exact token updates or character heuristics).
 * 2. Settled decoding speed calculated at the end of a generation turn.
 */

export interface StreamingSpeedSnapshot {
  tps: number;
  ttftMs?: number;
  elapsedMs: number;
  estimatedTokens: number;
}

/** Average characters per token heuristic for English/code text when provider does not stream token counts. */
const DEFAULT_CHARS_PER_TOKEN = 3.8;

export class StreamingSpeedTracker {
  private readonly startTime: number;
  private firstTokenTime: number | null = null;
  private lastUpdateTime: number | null = null;
  private accumulatedChars = 0;
  private exactTokens: number | null = null;
  private readonly charsPerToken: number;

  constructor(options?: { startTime?: number; charsPerToken?: number }) {
    this.startTime = options?.startTime ?? Date.now();
    this.charsPerToken = options?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  }

  /**
   * Record arrival of a text or reasoning delta string.
   */
  public recordDelta(text?: string | null, now: number = Date.now()): void {
    const length = text?.length ?? 0;
    if (length <= 0) return;
    if (this.firstTokenTime === null) {
      this.firstTokenTime = now;
    }
    this.accumulatedChars += length;
    this.lastUpdateTime = now;
  }

  /**
   * Record cumulative characters streamed (e.g. from tool call argument streaming).
   */
  public recordCumulativeChars(cumulativeChars: number, now: number = Date.now()): void {
    if (cumulativeChars <= 0) return;
    if (this.firstTokenTime === null) {
      this.firstTokenTime = now;
    }
    this.accumulatedChars = Math.max(this.accumulatedChars, cumulativeChars);
    this.lastUpdateTime = now;
  }

  /**
   * Record exact token counts if the provider streams usage updates.
   */
  public recordUsageTokens(completionTokens: number, now: number = Date.now()): void {
    if (this.firstTokenTime === null && completionTokens > 0) {
      this.firstTokenTime = now;
    }
    this.exactTokens = completionTokens;
    this.lastUpdateTime = now;
  }

  /**
   * Time to first token in milliseconds, or null if no tokens received yet.
   */
  public getTtftMs(): number | null {
    if (this.firstTokenTime === null) return null;
    return Math.max(0, this.firstTokenTime - this.startTime);
  }

  /**
   * Current estimated or exact token count generated so far.
   */
  public getEstimatedTokens(): number {
    if (this.exactTokens !== null) {
      return this.exactTokens;
    }
    return Math.round(this.accumulatedChars / this.charsPerToken);
  }

  /**
   * Get live tokens per second during an in-flight stream.
   *
   * Generation speed is measured from the arrival of the FIRST token to now (decoding speed),
   * excluding prefill/TTFT latency.
   */
  public getLiveTps(now: number = Date.now()): number | null {
    if (this.firstTokenTime === null) return null;

    const generationDurationMs = now - this.firstTokenTime;
    // Require at least 200ms of generation to avoid huge spikes on the first chunk
    if (generationDurationMs < 200) {
      return null;
    }

    const tokens = this.getEstimatedTokens();
    if (tokens <= 0) return null;

    const durationSec = generationDurationMs / 1000;
    const tps = tokens / durationSec;
    return Number.isFinite(tps) && tps > 0 ? Math.round(tps * 10) / 10 : null;
  }

  /**
   * Calculate exact settled tokens per second when generation finishes.
   *
   * @param finalCompletionTokens Exact completion tokens from provider's final usage.
   * @param endTime Generation end timestamp.
   */
  public getSettledTps(finalCompletionTokens?: number, endTime: number = Date.now()): number | null {
    const tokens = finalCompletionTokens ?? this.getEstimatedTokens();
    if (tokens <= 0) return null;

    // If firstTokenTime was never captured (e.g. non-streaming or instantaneous response),
    // measure from request startTime.
    const start = this.firstTokenTime ?? this.startTime;
    const durationMs = endTime - start;
    if (durationMs <= 0) return null;

    const durationSec = durationMs / 1000;
    const tps = tokens / durationSec;
    return Number.isFinite(tps) && tps > 0 ? Math.round(tps * 10) / 10 : null;
  }

  /**
   * Returns a complete snapshot of current speed metrics.
   */
  public getSnapshot(now: number = Date.now()): StreamingSpeedSnapshot | null {
    const tps = this.getLiveTps(now);
    if (tps === null) return null;

    return {
      tps,
      ttftMs: this.getTtftMs() ?? undefined,
      elapsedMs: Math.max(0, now - this.startTime),
      estimatedTokens: this.getEstimatedTokens(),
    };
  }
}
