export type ContextMilestoneReminderConfig = {
  enabled: boolean;
  milestones: readonly number[];
  autoBrief: boolean;
};

const RECONSIDERATION_INTERVAL_TOKENS = 50_000;

/** Emits configured milestones and bounded reconsideration reminders from provider usage. */
export class ContextMilestoneReminder {
  readonly #fired = new Set<number>();
  #nextReconsideration?: number;

  observe(inputTokens: number | undefined, config: ContextMilestoneReminderConfig): string[] {
    if (!config.enabled || inputTokens === undefined || !Number.isFinite(inputTokens) || inputTokens < 0) return [];

    const reminders: string[] = [];
    for (const milestone of config.milestones) {
      if (!Number.isFinite(milestone) || milestone <= 0 || this.#fired.has(milestone)) continue;
      if (inputTokens < milestone) continue;
      this.#fired.add(milestone);
      reminders.push(this.#message(inputTokens, `crossed rollover milestone: ${milestone}`, config));
    }
    if (reminders.length > 0) {
      this.#nextReconsideration = inputTokens + RECONSIDERATION_INTERVAL_TOKENS;
    } else if (this.#nextReconsideration !== undefined && inputTokens >= this.#nextReconsideration) {
      reminders.push(this.#message(inputTokens, 'reconsideration after deferral', config));
      this.#nextReconsideration = inputTokens + RECONSIDERATION_INTERVAL_TOKENS;
    }
    return reminders;
  }

  #message(inputTokens: number, trigger: string, config: ContextMilestoneReminderConfig): string {
    const preparation = config.autoBrief ? 'externalize the necessary state in a durable artifact and ' : '';
    return `The provider reported ${inputTokens} input tokens for the latest completed request (${trigger}). If the task is at a safe natural boundary, ${preparation}call session_rollover with a bounded handoff brief. If stopping now would strand work, lose important context, or interrupt an indivisible step, continue until the next safe natural boundary and reconsider then. Rollover remains optional at every later reminder.`;
  }
}
