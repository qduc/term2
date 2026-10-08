import type { DurableGoal, GoalStatus } from '../services/logging/conversation-log-events.js';
import { createDurableGoal, formatGoalStatus } from '../services/conversation/durable-goal.js';
import type { SlashCommand } from '../slash-commands.js';

export function createGoalSlashCommand(options: {
  getGoal: () => DurableGoal | undefined;
  setGoal: (goal: DurableGoal) => void;
  addSystemMessage: (text: string) => void;
}): SlashCommand {
  const show = (goal = options.getGoal()) => {
    if (!goal) {
      options.addSystemMessage('No durable goal is set. Use /goal set <outcome> [--criteria <text>].');
      return;
    }
    options.addSystemMessage(formatGoalStatus(goal));
  };
  return {
    name: 'goal',
    description: 'Inspect or update the durable session goal; /clear retains it',
    expectsArgs: true,
    action: (rawArgs = '') => {
      const [action, ...parts] = rawArgs.trim().split(/\s+/);
      try {
        if (!action || action === 'show') {
          show();
          return true;
        }
        if (action === 'set') {
          const text = parts.join(' ');
          const criteriaIndex = text.indexOf(' --criteria ');
          const outcome = criteriaIndex < 0 ? text : text.slice(0, criteriaIndex);
          const criteria = criteriaIndex < 0 ? undefined : text.slice(criteriaIndex + ' --criteria '.length);
          const goal = createDurableGoal(outcome, criteria);
          options.setGoal(goal);
          show(goal);
          return true;
        }
        if (action === 'achieved' || action === 'abandon') {
          const current = options.getGoal();
          if (!current) throw new Error('No durable goal is set. Use /goal set <outcome> first.');
          const status: GoalStatus = action === 'achieved' ? 'achieved' : 'abandoned';
          const goal = { ...current, status };
          options.setGoal(goal);
          show(goal);
          return true;
        }
        throw new Error('Usage: /goal [show|set <outcome> [--criteria <text>]|achieved|abandon]');
      } catch (error) {
        options.addSystemMessage(`Goal update failed: ${error instanceof Error ? error.message : String(error)}`);
        return true;
      }
    },
  };
}
