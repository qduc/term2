import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings/settings-service.js';

interface CreateSandboxSlashCommandDeps {
  settingsService: SettingsService;
  applyRuntimeSetting: (key: string, value: any) => void;
  addSystemMessage: (text: string) => void;
}

export function createSandboxSlashCommand({
  settingsService,
  applyRuntimeSetting,
  addSystemMessage,
}: CreateSandboxSlashCommandDeps): SlashCommand {
  return {
    name: 'sandbox',
    description: 'Toggle shell sandbox mode (restricts shell operations to a secure environment)',
    action: () => {
      const currentValue = settingsService.get('sandbox.enabled');
      const newValue = !currentValue;
      const modeBefore = settingsService.get('shell.autoApproveMode');

      settingsService.set('sandbox.enabled', newValue);
      applyRuntimeSetting('sandbox.enabled', newValue);

      const modeAfter = settingsService.get('shell.autoApproveMode');
      const demoteNote =
        newValue && modeBefore === 'always' && modeAfter !== 'always'
          ? ` Auto-approve mode demoted to ${modeAfter} (always requires the sandbox off).`
          : '';

      addSystemMessage(
        `Shell sandbox mode ${
          newValue
            ? 'enabled - restricting shell operations to a secure environment'
            : 'disabled - shell has unrestricted access'
        }${demoteNote}`,
      );
      return true;
    },
  };
}
