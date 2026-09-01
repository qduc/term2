import { describe, expect, it } from 'vitest';
import {
  assessBackgroundTaskLiveness,
  BACKGROUND_TASK_TOOL_LABEL_LIMIT,
  formatBackgroundTaskLiveness,
  normalizeBackgroundTaskActivity,
  sanitizeBackgroundTaskToolLabel,
} from './background-task-activity.js';

describe('assessBackgroundTaskLiveness', () => {
  it('clamps clock skew and uses the executor threshold', () => {
    expect(assessBackgroundTaskLiveness({ lastObservedAt: 1_000, now: 900, quietAfterMs: 50 })).toEqual({
      state: 'recent',
      lastObservedAt: 1_000,
      ageMs: 0,
    });
    expect(assessBackgroundTaskLiveness({ lastObservedAt: 1_000, now: 1_050, quietAfterMs: 50 }).state).toBe('quiet');
  });
});

describe('formatBackgroundTaskLiveness', () => {
  it('keeps lifecycle and evidence-age axes separate', () => {
    const activity = normalizeBackgroundTaskActivity({
      status: 'running',
      activityState: 'waiting',
      waitingReason: 'provider',
      lastObservation: { kind: 'request_dispatched', at: 0 },
      now: 8 * 60_000,
      quietAfterMs: 30_000,
    });

    expect(formatBackgroundTaskLiveness(activity)).toBe('waiting (provider), quiet; last observed 8m ago');
  });

  it('reports recent observations compactly and never infers a hang', () => {
    const activity = normalizeBackgroundTaskActivity({
      status: 'running',
      activityState: 'active',
      lastActivityAt: 1_000,
      now: 30_000,
      quietAfterMs: 30_000,
    });

    expect(formatBackgroundTaskLiveness(activity)).toBe('active, recent; last observed 29s ago');
    expect(formatBackgroundTaskLiveness(activity)).not.toContain('hung');
  });
});

describe('sanitizeBackgroundTaskToolLabel', () => {
  it('preserves ordinary names while bounding and neutralizing terminal controls', () => {
    expect(sanitizeBackgroundTaskToolLabel('read_file')).toBe('read_file');
    const sanitized = sanitizeBackgroundTaskToolLabel(`shell\n\u001b[31m${'x'.repeat(120)}`);
    expect(sanitized).not.toMatch(/[\n\u001b]/);
    expect(sanitized.length).toBeLessThanOrEqual(BACKGROUND_TASK_TOOL_LABEL_LIMIT);
    expect(sanitized.endsWith('…')).toBe(true);
  });
});
