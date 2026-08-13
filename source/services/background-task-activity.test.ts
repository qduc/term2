import { describe, expect, it } from 'vitest';
import { assessBackgroundTaskLiveness } from './background-task-activity.js';

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
