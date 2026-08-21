import type { SlashCommand } from '../slash-commands.js';

export function createUsageSlashCommand(
  addSystemMessage: (text: string) => void,
  getSessionUsage: () => string,
  /**
   * Asks the provider's own usage meter to refresh, bypassing its cooldown.
   *
   * Fired and forgotten rather than awaited: the meter lands in the status bar
   * a moment later, and the session usage below is available immediately. A
   * user who typed `/usage` is the one case where asking again straight away is
   * clearly wanted, so the cooldown yields to it.
   */
  refreshProviderUsage?: () => void,
): SlashCommand {
  return {
    name: 'usage',
    description: 'Show token usage for the current session',
    action: () => {
      refreshProviderUsage?.();
      addSystemMessage(getSessionUsage());
      return true;
    },
  };
}
