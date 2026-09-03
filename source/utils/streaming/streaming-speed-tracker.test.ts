import { describe, it, expect } from 'vitest';
import { formatTokensPerSecond, StreamingSpeedTracker } from './streaming-speed-tracker.js';

describe('StreamingSpeedTracker', () => {
  it('tracks TTFT correctly from request start to first token', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 1000 });
    expect(tracker.getTtftMs()).toBeNull();

    tracker.recordDelta('Hello', 1450);
    expect(tracker.getTtftMs()).toBe(450);

    // Subsequent deltas should not change TTFT
    tracker.recordDelta(' world', 1600);
    expect(tracker.getTtftMs()).toBe(450);
  });

  it('calculates live TPS based on character heuristics after minimum duration threshold', () => {
    // 3.8 chars per token
    const tracker = new StreamingSpeedTracker({ startTime: 1000, charsPerToken: 4.0 });

    tracker.recordDelta('abcd', 1200); // 4 chars = 1 token
    // At 1250ms (50ms after first token), below 200ms threshold -> null
    expect(tracker.getLiveTps(1250)).toBeNull();

    // At 2200ms (1000ms after first token), 40 chars = 10 tokens -> 10 tok / 1s = 10.0 tok/s
    tracker.recordDelta('e'.repeat(36), 1800);
    expect(tracker.getLiveTps(2200)).toBe(10);
  });

  it('uses exact usage tokens when reported', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 1000 });

    tracker.recordDelta('chunk 1', 1200);
    tracker.recordUsageTokens(50, 1700);

    // 50 tokens in 1000ms (from 1200 to 2200) -> 50 tok/s
    expect(tracker.getLiveTps(2200)).toBe(50);
  });

  it('calculates settled TPS accurately using final completion tokens', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 1000 });
    tracker.recordDelta('chunk', 1500); // first token at 1500

    // 100 completion tokens from 1500 to 3500 (2.0s) -> 50.0 tok/s
    const settled = tracker.getSettledTps({ completionTokens: 100, endTime: 3500 });
    expect(settled).toEqual({ tps: 50, approximate: false });
  });

  it('does not invent a wall-clock duration when no visible token was recorded', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 1000 });
    expect(tracker.getSettledTps({ completionTokens: 60, endTime: 3000 })).toBeNull();
  });

  it('uses provider completion_ms instead of wall-clock when present', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 1000 });
    tracker.recordDelta('chunk', 1500);

    // Wall-clock would be 2500ms -> 40 tok/s. Provider decode time is 1000ms -> 100 tok/s.
    const settled = tracker.getSettledTps({ completionTokens: 100, completionMs: 1000, endTime: 4000 });
    expect(settled).toEqual({ tps: 100, approximate: false });
  });

  it('can settle from completion_ms even without a visible delta', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 1000 });
    const settled = tracker.getSettledTps({ completionTokens: 80, completionMs: 2000, endTime: 4000 });
    expect(settled).toEqual({ tps: 40, approximate: false });
  });

  it('subtracts reasoning_tokens from the settled numerator when reported', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 0 });
    tracker.recordDelta('visible', 0);

    // 100 completion tokens of which 80 are reasoning, over 1s of visible stream -> 20 tok/s.
    const settled = tracker.getSettledTps({ completionTokens: 100, reasoningTokens: 80, endTime: 1000 });
    expect(settled).toEqual({ tps: 20, approximate: false });
  });

  it('marks settled TPS approximate when completion tokens dwarf visible output and reasoning is unreported', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 0, charsPerToken: 4.0 });
    tracker.recordDelta('a'.repeat(40), 0); // ~10 visible tokens

    const settled = tracker.getSettledTps({ completionTokens: 100, endTime: 1000 });
    expect(settled).toEqual({ tps: 100, approximate: true });
  });

  it('does not mark approximate when completion_ms is the duration source', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 0, charsPerToken: 4.0 });
    tracker.recordDelta('a'.repeat(40), 0);

    const settled = tracker.getSettledTps({ completionTokens: 100, completionMs: 1000, endTime: 1000 });
    expect(settled).toEqual({ tps: 100, approximate: false });
  });

  it('attaches the decode window when the settled rate exceeds plausible single-sequence decode', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 0 });
    tracker.recordDelta('visible', 0);

    // 1000 visible tokens over a 0.2s tail window -> 5000 tok/s: a burst, not decode.
    const settled = tracker.getSettledTps({ completionTokens: 1000, endTime: 200 });
    expect(settled?.tps).toBe(5000);
    expect(settled?.decodeWindowMs).toBe(200);
  });

  it('omits the decode window for plausible sustained rates', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 0 });
    tracker.recordDelta('visible', 0);

    const settled = tracker.getSettledTps({ completionTokens: 100, endTime: 1000 });
    expect(settled).toEqual({ tps: 100, approximate: false });
    expect(settled?.decodeWindowMs).toBeUndefined();
  });

  it('omits the decode window when a provider duration scopes the rate', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 0 });
    tracker.recordDelta('visible', 0);

    const settled = tracker.getSettledTps({ completionTokens: 1000, completionMs: 200, endTime: 200 });
    expect(settled?.tps).toBe(5000);
    expect(settled?.decodeWindowMs).toBeUndefined();
  });

  it('keeps provider completion_ms paired with full completion_tokens', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 0 });
    tracker.recordDelta('visible', 0);

    const settled = tracker.getSettledTps({
      completionTokens: 100,
      reasoningTokens: 80,
      completionMs: 1000,
      endTime: 1000,
    });
    expect(settled).toEqual({ tps: 100, approximate: false });
  });

  it('reflects recent throughput after a slow start, not the whole-turn average', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 0, charsPerToken: 4.0 });

    // Slow trickle: 1 token/sec for the first 3 seconds.
    tracker.recordDelta('abcd', 0); // t=0, 1 token total
    tracker.recordDelta('abcd', 1000); // t=1000, 2 tokens total
    tracker.recordDelta('abcd', 2000); // t=2000, 3 tokens total
    tracker.recordDelta('abcd', 3000); // t=3000, 4 tokens total

    // Fast burst: 100 more tokens (400 chars) arrive between t=3000 and t=4000.
    tracker.recordDelta('e'.repeat(400), 4000); // t=4000, 104 tokens total

    // Whole-turn average: 104 tok / 4s = 26 tok/s.
    // Windowed (last 3000ms, anchored at the t=1000 sample): (104-2) tok / 3s = 34 tok/s,
    // which should be higher since it isn't dragged down by the slow start.
    const wholeTurnAverage = 104 / 4;
    const live = tracker.getLiveTps(4000);
    expect(live).not.toBeNull();
    expect(live!).toBeGreaterThan(wholeTurnAverage);
    expect(live).toBe(34);
  });

  it('resets to a fresh measurement at request boundaries (e.g. tool execution)', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 0, charsPerToken: 4.0 });

    // First request: model streams 40 chars (10 tokens) over 1s: t=0 -> t=1000.
    tracker.recordDelta('a'.repeat(4), 0); // first token at t=0, 1 token
    tracker.recordDelta('a'.repeat(36), 1000); // 40 chars total = 10 tokens at t=1000
    expect(tracker.getSettledTps({ endTime: 1000 })?.tps).toBe(10);

    // Tool executes for 5s: t=1000 -> t=6000. Turn boundary: reset for the next request.
    tracker.reset(6000);
    expect(tracker.getTtftMs()).toBeNull();
    expect(tracker.getEstimatedTokens()).toBe(0);

    // Second request: model streams 20 tokens (80 chars) over 1s, measured from zero — the 5s
    // tool gap and the first request's tokens must not appear in this request's numbers at all.
    tracker.recordDelta('b'.repeat(4), 6000); // first token of the new request at t=6000
    tracker.recordDelta('b'.repeat(76), 7000); // 80 chars total = 20 tokens at t=7000

    expect(tracker.getTtftMs()).toBe(0); // measured from the reset point, not the original turn start
    const settled = tracker.getSettledTps({ endTime: 7000 });
    expect(settled?.tps).toBe(20); // 20 tokens / 1s, unaffected by the earlier request or the tool gap
  });

  it('applies a mid-stream usage calibration to later deltas of the same request', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 0, charsPerToken: 4.0 });

    tracker.recordDelta('a'.repeat(200), 0);
    tracker.recordUsageTokens(20, 1000); // observed ratio is 10 chars/token
    tracker.recordDelta('b'.repeat(50), 1500); // +5 tokens at the calibrated ratio

    expect(tracker.getEstimatedTokens()).toBe(25);
    expect(tracker.getLiveTps(1500)).toBe(16.7); // 25 tok / 1.5s
  });

  it('sums streamed text and tool-argument characters instead of taking the max', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 0, charsPerToken: 4.0 });
    tracker.recordDelta('a'.repeat(40), 0); // 10 tokens of text
    tracker.recordCumulativeChars(40, 500); // 10 more tokens of tool args

    expect(tracker.getEstimatedTokens()).toBe(20);
  });

  it('formats tok/s with a tilde when the value is approximate', () => {
    expect(formatTokensPerSecond(48.2)).toBe('48.2 tok/s');
    expect(formatTokensPerSecond(48.2, true)).toBe('~48.2 tok/s');
  });

  it('calibrates chars-per-token from real usage and carries it across reset() to the next request', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 0, charsPerToken: 4.0 });

    // First request: 200 chars stream in, but the real usage says only 20 tokens -> true ratio
    // is 10 chars/token, very different from the constructor's default of 4.0.
    tracker.recordDelta('a'.repeat(200), 500);
    tracker.recordUsageTokens(20, 1000);
    expect(tracker.getEstimatedTokens()).toBe(20); // exact usage, not the heuristic

    tracker.reset(2000); // tool boundary

    // Second request: only 50 chars have streamed so far (no usage yet). With the stale 4.0
    // default this would estimate 12-13 tokens; calibrated at 10 chars/token it should be ~5.
    tracker.recordDelta('b'.repeat(50), 2500);
    expect(tracker.getEstimatedTokens()).toBe(5);
  });

  it('returns snapshot with full metrics', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 1000, charsPerToken: 4.0 });
    tracker.recordDelta('a'.repeat(40), 1200); // 10 tokens

    const snapshot = tracker.getSnapshot(2200);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.ttftMs).toBe(200);
    expect(snapshot?.elapsedMs).toBe(1200);
    expect(snapshot?.estimatedTokens).toBe(10);
    expect(snapshot?.tps).toBe(10);
  });
});
