import type { ContextEstimate } from './index.js';

export type ContextMilestoneReminderConfig = {
  enabled: boolean;
  milestones: readonly number[];
  autoBrief: boolean;
};

/** Emits each configured milestone at most once for the lifetime of this instance. */
export class ContextMilestoneReminder {
  readonly #fired = new Set<number>();

  observe(estimate: ContextEstimate, config: ContextMilestoneReminderConfig, compactionThreshold?: number): string[] {
    if (!config.enabled) return [];

    const reminders: string[] = [];
    for (const milestone of config.milestones) {
      if (!Number.isFinite(milestone) || milestone <= 0 || this.#fired.has(milestone)) continue;
      if (estimate.renderedInputTokens < milestone) continue;
      this.#fired.add(milestone);
      reminders.push(
        `Context is at approximately ${estimate.renderedInputTokens} tokens (milestone: ${milestone}). ${
          config.autoBrief
            ? 'If the current task has reached a natural boundary, externalize state (docs/memory) and consider calling session_rollover with a handoff brief.'
            : 'If the current task has reached a natural boundary, consider calling session_rollover with a handoff brief.'
        }${
          compactionThreshold === undefined
            ? ''
            : ` Automatic compaction will trigger at approximately ${compactionThreshold} tokens.`
        }`,
      );
    }
    return reminders;
  }
}
