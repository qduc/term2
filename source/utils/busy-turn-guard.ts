import type { SlashCommand } from '../slash-commands.js';

/**
 * Wrap a command's action so it refuses to run while an agent turn is in
 * flight. The wrapper preserves the command's identity (name, description,
 * completion, argument grammar) and interposes only on the action, so every
 * dispatch path — typed submit, the intent host, and the slash menu — sees
 * the same refusal.
 *
 * Blocked invocations report the refusal through `notify` and count as
 * handled (the composer is cleared), mirroring how the mid-session mode guard
 * in `guarded-settings-command` behaves.
 */
export function guardAgainstBusyTurn(
  command: SlashCommand,
  deps: { turnInFlight: () => boolean; notify: (text: string) => void },
): SlashCommand {
  return {
    ...command,
    action: (args?: string) => {
      if (deps.turnInFlight()) {
        deps.notify(
          `/${command.name} cannot run while the agent is working. Stop the current turn first (press Escape twice), then try again.`,
        );
        return true;
      }
      return command.action(args);
    },
  };
}
