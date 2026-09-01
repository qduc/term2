import { describe, it, expect } from 'vitest';
import { AbortedStreamRecorder } from './aborted-stream-recorder.js';

function fakeClock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

describe('AbortedStreamRecorder', () => {
  it('retains every observed event so an aborted stream can be replayed', () => {
    const recorder = new AbortedStreamRecorder();
    recorder.observe({ type: 'response.output_text.delta', delta: 'alpha' });
    recorder.observe({ type: 'response.output_text.delta', delta: 'beta' });

    const diagnostics = recorder.diagnostics();

    expect(diagnostics.events).toEqual([
      { type: 'response.output_text.delta', delta: 'alpha' },
      { type: 'response.output_text.delta', delta: 'beta' },
    ]);
  });

  it('counts events by type so a runaway generation is distinguishable from a stall', () => {
    const recorder = new AbortedStreamRecorder();
    recorder.observe({ type: 'response.reasoning_summary_text.delta' });
    recorder.observe({ type: 'response.reasoning_summary_text.delta' });
    recorder.observe({ type: 'response.output_item.added' });
    recorder.observe({ notAnEvent: true });

    expect(recorder.diagnostics().eventTypeCounts).toEqual({
      'response.reasoning_summary_text.delta': 2,
      'response.output_item.added': 1,
      unknown: 1,
    });
  });

  it('reports the largest gap between events, which is what separates a stall from steady output', () => {
    // Elapsed reads: construction, then one per observe, then diagnostics.
    const recorder = new AbortedStreamRecorder(fakeClock([0, 100, 4100, 4200, 5000]));
    recorder.observe({ type: 'a' });
    recorder.observe({ type: 'b' });
    recorder.observe({ type: 'c' });

    const diagnostics = recorder.diagnostics();

    expect(diagnostics.firstEventMs).toBe(100);
    expect(diagnostics.lastEventMs).toBe(4200);
    expect(diagnostics.maxGapMs).toBe(4000);
    expect(diagnostics.durationMs).toBe(5000);
  });

  it('captures the response id from either event shape', () => {
    const nested = new AbortedStreamRecorder();
    nested.observe({ type: 'response.created', response: { id: 'resp_nested' } });
    expect(nested.diagnostics().responseId).toBe('resp_nested');

    const flat = new AbortedStreamRecorder();
    flat.observe({ type: 'response.output_text.delta', response_id: 'resp_flat' });
    expect(flat.diagnostics().responseId).toBe('resp_flat');
  });

  it('drops the transcript once released, because a terminal event makes it redundant', () => {
    const recorder = new AbortedStreamRecorder();
    recorder.observe({ type: 'response.output_text.delta', delta: 'alpha' });
    recorder.release();

    const diagnostics = recorder.diagnostics();

    expect(diagnostics.events).toEqual([]);
    // Metrics survive release; only the payload is discarded.
    expect(diagnostics.eventTypeCounts).toEqual({ 'response.output_text.delta': 1 });
  });

  it('reports a stream that produced no events at all', () => {
    const diagnostics = new AbortedStreamRecorder(fakeClock([0, 300_000])).diagnostics();

    expect(diagnostics.events).toEqual([]);
    expect(diagnostics.eventTypeCounts).toEqual({});
    expect(diagnostics.firstEventMs).toBeUndefined();
    expect(diagnostics.maxGapMs).toBeUndefined();
    expect(diagnostics.durationMs).toBe(300_000);
  });

  it('classifies observed frames into bounded text/reasoning/tool/usage/heartbeat_or_unknown categories', () => {
    const recorder = new AbortedStreamRecorder();
    recorder.observe({ type: 'response.output_text.delta', delta: 'hi' });
    recorder.observe({ type: 'response.reasoning_summary_text.delta', delta: 'thinking' });
    recorder.observe({ type: 'response.function_call_arguments.delta', delta: '{}' });
    recorder.observe({ type: 'response.completed', response: { usage: { total_tokens: 10 } } });
    recorder.observe({ type: 'response.created' });
    recorder.observe({ notAnEvent: true });

    expect(recorder.diagnostics().progressCategoryCounts).toEqual({
      text: 1,
      reasoning: 1,
      tool: 1,
      usage: 1,
      heartbeat_or_unknown: 2,
    });
  });

  it("captures a raw close frame's code and reason so an abnormal close is explainable", () => {
    const recorder = new AbortedStreamRecorder();
    recorder.observe({ type: 'response.created' });
    recorder.observe({ type: 'close', code: 1006, reason: 'abnormal closure' });

    const diagnostics = recorder.diagnostics();
    expect(diagnostics.closeCode).toBe(1006);
    expect(diagnostics.closeReason).toBe('abnormal closure');
    expect(recorder.sawFailureFrame()).toBe(true);
  });

  it('does not report a failure frame when none was observed', () => {
    const recorder = new AbortedStreamRecorder();
    recorder.observe({ type: 'response.output_text.delta', delta: 'hi' });

    expect(recorder.sawFailureFrame()).toBe(false);
    expect(recorder.diagnostics().closeCode).toBeUndefined();
  });

  it('boundedDiagnostics omits the raw transcript but keeps category/counter/timing evidence', () => {
    const recorder = new AbortedStreamRecorder();
    recorder.observe({ type: 'response.output_text.delta', delta: 'sensitive payload text' });
    recorder.observe({ type: 'close', code: 1006 });

    const bounded = recorder.boundedDiagnostics();
    expect(bounded).not.toHaveProperty('events');
    expect(bounded.eventTypeCounts).toEqual({ 'response.output_text.delta': 1, close: 1 });
    expect(bounded.progressCategoryCounts.text).toBe(1);
    expect(bounded.closeCode).toBe(1006);
    expect(JSON.stringify(bounded)).not.toContain('sensitive payload text');
  });
});
