import { describe, expect, it } from 'vitest';
import {
  assessBackgroundTaskLiveness,
  BACKGROUND_TASK_TOOL_LABEL_LIMIT,
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

describe('sanitizeBackgroundTaskToolLabel', () => {
  it('preserves ordinary names while bounding and neutralizing terminal controls', () => {
    expect(sanitizeBackgroundTaskToolLabel('read_file')).toBe('read_file');
    const sanitized = sanitizeBackgroundTaskToolLabel(`shell\n\u001b[31m${'x'.repeat(120)}`);
    expect(sanitized).not.toMatch(/[\n\u001b]/);
    expect(sanitized.length).toBeLessThanOrEqual(BACKGROUND_TASK_TOOL_LABEL_LIMIT);
    expect(sanitized.endsWith('…')).toBe(true);
  });
});
