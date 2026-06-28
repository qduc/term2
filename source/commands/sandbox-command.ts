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
      const currentValue = settingsService.get<boolean>('sandbox.enabled');
      const newValue = !currentValue;

      settingsService.set('sandbox.enabled', newValue);
      applyRuntimeSetting('sandbox.enabled', newValue);

      addSystemMessage(
        `Shell sandbox mode ${
          newValue
            ? 'enabled - restricting shell operations to a secure environment'
            : 'disabled - shell has unrestricted access'
        }`,
      );
      return true;
    },
  };
}
