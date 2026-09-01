/**
 * Utility for tracking token streaming speed (tokens per second / TPS).
 *
 * Handles both:
 * 1. Live generation speed during streaming (using exact token updates or character heuristics).
 * 2. Settled decoding speed calculated at the end of a generation turn.
 *
 * A single agent turn can involve multiple separate model requests interleaved with tool
 * execution (model generates, calls a tool, tool runs, model resumes with a fresh request).
 * Tool-execution latency is not generation, so the tracker is reset at each such boundary
 * (see `reset()`) rather than averaged across the whole turn — each request's speed is measured
 * independently, starting from zero.
 */

export interface StreamingSpeedSnapshot {
  tps: number;
  ttftMs?: number;
  elapsedMs: number;
  estimatedTokens: number;
}

/** Average characters per token heuristic for English/code text when provider does not stream token counts. */
const DEFAULT_CHARS_PER_TOKEN = 3.8;

/** Live speed is computed over a trailing window so it tracks current throughput, not the whole-request average. */
const LIVE_WINDOW_MS = 3000;

interface TokenSample {
  time: number;
  tokens: number;
}

export class StreamingSpeedTracker {
  private startTime: number;
  private firstTokenTime: number | null = null;
  private lastUpdateTime: number | null = null;
  private accumulatedChars = 0;
  private exactTokens: number | null = null;
  private readonly charsPerToken: number;
  /** Rolling history of (time, cumulative token count) samples, oldest first, used for windowed live TPS. */
  private samples: TokenSample[] = [];

  constructor(options?: { startTime?: number; charsPerToken?: number }) {
    this.startTime = options?.startTime ?? Date.now();
    this.charsPerToken = options?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  }

  /**
   * Reset all accumulated state so the next recorded token starts a brand-new measurement,
   * unrelated to anything recorded before this call. Call this at request boundaries within a
   * turn — e.g. when a tool starts executing — so tool latency never mixes into decode speed and
   * the next model request's speed isn't diluted by a previous request's average.
   */
  public reset(now: number = Date.now()): void {
    this.startTime = now;
    this.firstTokenTime = null;
    this.lastUpdateTime = null;
    this.accumulatedChars = 0;
    this.exactTokens = null;
    this.samples = [];
  }

  private recordSample(now: number): void {
    this.samples.push({ time: now, tokens: this.getEstimatedTokens() });
    // Drop samples older than the window plus one extra so we always have a boundary sample to interpolate from.
    const cutoff = now - LIVE_WINDOW_MS * 2;
    while (this.samples.length > 1 && this.samples[0].time < cutoff) {
      this.samples.shift();
    }
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
    this.recordSample(now);
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
    this.recordSample(now);
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
    this.recordSample(now);
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
   * Computed over a trailing window (LIVE_WINDOW_MS) of recent samples rather than the
   * whole-request average, so the displayed number tracks current throughput instead of trailing
   * behind a slow start. Falls back to the full-history average until enough time has elapsed
   * since the first token to fill a window. `reset()` clears history at request boundaries, so
   * this never spans across a tool-execution gap or a prior request.
   */
  public getLiveTps(now: number = Date.now()): number | null {
    if (this.firstTokenTime === null) return null;

    const generationDurationMs = now - this.firstTokenTime;
    // Require at least 200ms of generation to avoid huge spikes on the first chunk
    if (generationDurationMs < 200) {
      return null;
    }

    const tokensNow = this.getEstimatedTokens();
    if (tokensNow <= 0) return null;

    const windowStart = now - LIVE_WINDOW_MS;
    // Find the newest sample at or before windowStart to anchor the window; if none exists
    // (turn is younger than the window), anchor at the first token instead.
    let anchor: TokenSample | null = null;
    for (const sample of this.samples) {
      if (sample.time <= windowStart) {
        anchor = sample;
      } else {
        break;
      }
    }

    const anchorTime = anchor ? anchor.time : this.firstTokenTime;
    const anchorTokens = anchor ? anchor.tokens : 0;

    const durationMs = now - anchorTime;
    const tokens = tokensNow - anchorTokens;
    if (durationMs < 200 || tokens <= 0) return null;

    const durationSec = durationMs / 1000;
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
