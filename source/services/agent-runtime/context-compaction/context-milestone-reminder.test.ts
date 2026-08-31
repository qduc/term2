import { describe, expect, it } from 'vitest';
import { ContextMilestoneReminder } from './context-milestone-reminder.js';

describe('ContextMilestoneReminder', () => {
  it('asks for an immediate boundary decision before automatic compaction resumes', () => {
    const [reminder] = new ContextMilestoneReminder().observe(
      { renderedInputTokens: 200, outputReserveTokens: 0, safetyReserveTokens: 0, hardFitTokens: 200 },
      { enabled: true, milestones: [100], autoBrief: true },
      250,
    );

    expect(reminder).toContain('decide now');
    expect(reminder).toContain('Automatic compaction is deferred for this request boundary only');
    expect(reminder).toContain('session_rollover');
  });

  it('emits each crossed milestone once, including milestones crossed in one jump', () => {
    const producer = new ContextMilestoneReminder();
    const config = { enabled: true, milestones: [100, 200, 300], autoBrief: true };

    expect(
      producer.observe(
        { renderedInputTokens: 250, outputReserveTokens: 0, safetyReserveTokens: 0, hardFitTokens: 250 },
        config,
      ),
    ).toHaveLength(2);
    expect(
      producer.observe(
        { renderedInputTokens: 350, outputReserveTokens: 0, safetyReserveTokens: 0, hardFitTokens: 350 },
        config,
      ),
    ).toHaveLength(1);
    expect(
      producer.observe(
        { renderedInputTokens: 400, outputReserveTokens: 0, safetyReserveTokens: 0, hardFitTokens: 400 },
        config,
      ),
    ).toEqual([]);
  });

  it('does not emit while disabled', () => {
    const producer = new ContextMilestoneReminder();
    expect(
      producer.observe(
        { renderedInputTokens: 1_000, outputReserveTokens: 0, safetyReserveTokens: 0, hardFitTokens: 1_000 },
        { enabled: false, milestones: [1], autoBrief: true },
      ),
    ).toEqual([]);
  });
});
