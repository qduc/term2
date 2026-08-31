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
            ? 'You must decide now whether the current task has reached a natural boundary. If it has, externalize state (docs/memory) and call session_rollover with a handoff brief before doing more work.'
            : 'You must decide now whether the current task has reached a natural boundary. If it has, call session_rollover with a handoff brief before doing more work.'
        }${
          compactionThreshold === undefined
            ? ''
            : ` Automatic compaction is deferred for this request boundary only; if you continue, it may run at the next boundary after approximately ${compactionThreshold} tokens.`
        }`,
      );
    }
    return reminders;
  }
}
