import { describe, it, expect } from 'vitest';
import { StreamingSpeedTracker } from './streaming-speed-tracker.js';

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
    const settled = tracker.getSettledTps(100, 3500);
    expect(settled).toBe(50);
  });

  it('falls back to request start time if first token timestamp was not captured', () => {
    const tracker = new StreamingSpeedTracker({ startTime: 1000 });
    // Non-streaming final response with 60 tokens arriving at 3000 (2.0s) -> 30.0 tok/s
    const settled = tracker.getSettledTps(60, 3000);
    expect(settled).toBe(30);
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
