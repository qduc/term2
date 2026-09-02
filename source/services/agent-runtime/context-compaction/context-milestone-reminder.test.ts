import { describe, expect, it } from 'vitest';
import { ContextMilestoneReminder } from './context-milestone-reminder.js';

describe('ContextMilestoneReminder', () => {
  it('offers a safe-boundary choice using provider-reported input usage only', () => {
    const [reminder] = new ContextMilestoneReminder().observe(210_000, {
      enabled: true,
      milestones: [200_000],
      autoBrief: true,
    });

    expect(reminder).toContain('provider reported 210000 input tokens');
    expect(reminder).toContain('safe natural boundary');
    expect(reminder).toContain('continue until the next safe natural boundary');
    expect(reminder).toContain('session_rollover');
    expect(reminder).not.toContain('compaction');
    expect(reminder).not.toContain('mandatory');
  });

  it('emits each crossed milestone once, including milestones crossed in one jump', () => {
    const producer = new ContextMilestoneReminder();
    const config = { enabled: true, milestones: [100_000, 200_000, 300_000], autoBrief: true };

    expect(producer.observe(250_000, config)).toHaveLength(2);
    expect(producer.observe(350_000, config)).toHaveLength(1);
    expect(producer.observe(400_000, config)).toHaveLength(1);
  });

  it('reconsiders at a bounded 50k-token cadence after deferral without making rollover mandatory', () => {
    const producer = new ContextMilestoneReminder();
    const config = { enabled: true, milestones: [200_000], autoBrief: true };

    expect(producer.observe(200_000, config)).toHaveLength(1);
    expect(producer.observe(249_999, config)).toEqual([]);
    const [reminder] = producer.observe(250_000, config);

    expect(reminder).toContain('reconsider');
    expect(reminder).toContain('continue until the next safe natural boundary');
  });

  it('does not emit while disabled', () => {
    const producer = new ContextMilestoneReminder();
    expect(producer.observe(1_000, { enabled: false, milestones: [1], autoBrief: true })).toEqual([]);
  });

  it('does not fall back when provider input usage is unavailable', () => {
    const producer = new ContextMilestoneReminder();
    expect(producer.observe(undefined, { enabled: true, milestones: [1], autoBrief: true })).toEqual([]);
  });
});
