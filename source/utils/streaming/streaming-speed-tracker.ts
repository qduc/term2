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

export interface SettledStreamingSpeed {
  tps: number;
  approximate: boolean;
  /**
   * Decode-window duration in ms when the settled rate exceeds what one
   * sequence plausibly sustains (MAX_PLAUSIBLE_DECODE_TPS). Lets the footer
   * show what fraction of the turn the rate actually describes.
   */
  decodeWindowMs?: number;
}

/** Average characters per token heuristic for English/code text when provider does not stream token counts. */
export const DEFAULT_CHARS_PER_TOKEN = 3.8;

/** Live speed is computed over a trailing window so it tracks current throughput, not the whole-request average. */
const LIVE_WINDOW_MS = 3000;

/** Bounds for a request's observed chars-per-token ratio, so one noisy request can't skew future estimates wildly. */
const MIN_CALIBRATED_CHARS_PER_TOKEN = 1;
const MAX_CALIBRATED_CHARS_PER_TOKEN = 10;
/** Minimum accumulated characters required before trusting a request's ratio for calibration. */
const MIN_CHARS_FOR_CALIBRATION = 20;
/** Completion tokens this far above the visible char estimate imply hidden tokens in the numerator. */
const HIDDEN_TOKEN_RATIO = 2;

/**
 * Single-sequence decode rates above this are not plausible production
 * throughput — the numerator/denominator pair describes a burst or a tail
 * window, not sustained decode. Calibrated against a day of OpenRouter
 * muse-spark traffic (n=1410, honest full-request p99 ≈ 670 tok/s): a 500
 * cutoff marks 81% of settled figures as burst-inflated while clearing
 * genuine sustained rates (median honest ≈ 60 tok/s) by a wide margin.
 */
export const MAX_PLAUSIBLE_DECODE_TPS = 500;

export function formatTokensPerSecond(tps: number, approximate = false): string {
  const value = tps.toFixed(1);
  return approximate ? `~${value} tok/s` : `${value} tok/s`;
}

interface TokenSample {
  time: number;
  tokens: number;
}

export class StreamingSpeedTracker {
  private startTime: number;
  private firstTokenTime: number | null = null;
  private lastUpdateTime: number | null = null;
  private streamedTextChars = 0;
  private toolArgChars = 0;
  private committedToolArgChars = 0;
  private accumulatedChars = 0;
  private exactTokens: number | null = null;
  /** Character count at the last `recordUsageTokens` sample, so later deltas can be added on top. */
  private charsAtExactTokens = 0;
  /**
   * Chars-per-token used for live estimates before exact usage arrives. Starts at
   * `DEFAULT_CHARS_PER_TOKEN` and is recalibrated from each request's real usage in
   * `recordUsageTokens`, so it survives `reset()` and carries forward to seed the next request's
   * estimate within the same turn.
   */
  private charsPerToken: number;
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
   *
   * `charsPerToken` is deliberately NOT reset — it carries the last request's calibrated ratio
   * forward to seed the next request's live estimate.
   */
  public reset(now: number = Date.now()): void {
    this.startTime = now;
    this.firstTokenTime = null;
    this.lastUpdateTime = null;
    this.streamedTextChars = 0;
    this.toolArgChars = 0;
    this.committedToolArgChars = 0;
    this.accumulatedChars = 0;
    this.exactTokens = null;
    this.charsAtExactTokens = 0;
    this.samples = [];
  }

  public getCharsPerToken(): number {
    return this.charsPerToken;
  }

  private refreshAccumulatedChars(): void {
    this.accumulatedChars = this.streamedTextChars + this.committedToolArgChars + this.toolArgChars;
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
    this.streamedTextChars += length;
    this.refreshAccumulatedChars();
    this.lastUpdateTime = now;
    this.recordSample(now);
  }

  /**
   * Record cumulative characters streamed (e.g. from tool call argument streaming).
   * Argument counts are cumulative per tool call, so a drop commits the previous
   * tool's chars and starts a new one. Text and tool-arg chars are summed: both
   * count toward completion tokens.
   */
  public recordCumulativeChars(cumulativeChars: number, now: number = Date.now()): void {
    if (cumulativeChars <= 0) return;
    if (this.firstTokenTime === null) {
      this.firstTokenTime = now;
    }
    if (cumulativeChars < this.toolArgChars) {
      this.committedToolArgChars += this.toolArgChars;
    }
    this.toolArgChars = cumulativeChars;
    this.refreshAccumulatedChars();
    this.lastUpdateTime = now;
    this.recordSample(now);
  }

  /**
   * Record exact token counts if the provider streams usage updates.
   * Calibrates the live chars-per-token ratio for this request's remaining
   * deltas, not only the next request.
   */
  public recordUsageTokens(completionTokens: number, now: number = Date.now()): void {
    this.exactTokens = completionTokens;
    this.lastUpdateTime = now;
    this.calibrateCharsPerToken(completionTokens);
    this.charsAtExactTokens = this.accumulatedChars;
    this.recordSample(now);
  }

  /**
   * Recalibrate the chars-per-token ratio from this request's real accumulated chars vs. its
   * exact token count, so later deltas of this request and the next request after `reset()`
   * start from an observed ratio instead of the generic default. Ignored if there isn't enough
   * accumulated text to trust the sample (e.g. a tool-only request with no generated text).
   */
  private calibrateCharsPerToken(exactTokens: number): void {
    if (exactTokens <= 0 || this.accumulatedChars < MIN_CHARS_FOR_CALIBRATION) return;
    const ratio = this.accumulatedChars / exactTokens;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    this.charsPerToken = Math.min(MAX_CALIBRATED_CHARS_PER_TOKEN, Math.max(MIN_CALIBRATED_CHARS_PER_TOKEN, ratio));
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
      const extraChars = Math.max(0, this.accumulatedChars - this.charsAtExactTokens);
      return this.exactTokens + Math.round(extraChars / this.charsPerToken);
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
   * Calculate settled tokens per second when generation finishes.
   *
   * Prefers the provider's `completion_ms` when present. Otherwise measures
   * wall-clock from the first visible token. Returns null rather than silently
   * falling back to request start (which would mix TTFT into decode speed).
   */
  public getSettledTps(options?: {
    completionTokens?: number;
    reasoningTokens?: number;
    completionMs?: number;
    endTime?: number;
  }): SettledStreamingSpeed | null {
    const rawTokens = options?.completionTokens ?? this.getEstimatedTokens();
    if (rawTokens <= 0) return null;

    const completionMs = options?.completionMs;
    const hasProviderDuration = completionMs != null && completionMs > 0;
    const endTime = options?.endTime ?? Date.now();
    const durationMs = hasProviderDuration
      ? completionMs
      : this.firstTokenTime !== null
      ? endTime - this.firstTokenTime
      : null;
    if (durationMs == null || durationMs <= 0) return null;

    // Provider duration already covers hidden reasoning. Only strip those tokens
    // from the wall-clock path, where the clock started at the first visible delta.
    const reasoningTokens = options?.reasoningTokens ?? 0;
    const visibleTokens = rawTokens - reasoningTokens;
    const subtractedReasoning = !hasProviderDuration && reasoningTokens > 0 && visibleTokens > 0;
    const tokens = subtractedReasoning ? visibleTokens : rawTokens;

    const tps = tokens / (durationMs / 1000);
    if (!Number.isFinite(tps) || tps <= 0) return null;

    const approximate = !hasProviderDuration && !subtractedReasoning && this.isHiddenReasoningInflated(rawTokens);
    const settled: SettledStreamingSpeed = { tps: Math.round(tps * 10) / 10, approximate };
    // A settled rate no single sequence plausibly sustains describes a burst
    // or tail window, not sustained decode. Attach the window so the footer
    // can show what fraction of the turn it covers. Only the wall-clock path
    // needs this: a provider duration already scopes the rate honestly.
    if (!hasProviderDuration && settled.tps > MAX_PLAUSIBLE_DECODE_TPS) {
      settled.decodeWindowMs = durationMs;
    }
    return settled;
  }

  private isHiddenReasoningInflated(completionTokens: number): boolean {
    if (this.accumulatedChars < MIN_CHARS_FOR_CALIBRATION) return false;
    const visibleEstimate = this.accumulatedChars / this.charsPerToken;
    if (!Number.isFinite(visibleEstimate) || visibleEstimate <= 0) return false;
    return completionTokens >= visibleEstimate * HIDDEN_TOKEN_RATIO;
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
