import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings-service.js';
import { createSettingsCommand } from '../utils/settings-command.js';

interface CreateGuardedSettingsCommandDeps {
  settingsService: SettingsService;
  addSystemMessage: (text: string) => void;
  applyRuntimeSetting?: (key: string, value: any) => void;
  setInput: (value: string) => void;
  messages: { sender: string }[];
}

export function createGuardedSettingsCommand({
  settingsService,
  addSystemMessage,
  applyRuntimeSetting,
  setInput,
  messages,
}: CreateGuardedSettingsCommandDeps): SlashCommand {
  const settingsCommand = createSettingsCommand({
    settingsService,
    addSystemMessage,
    applyRuntimeSetting,
    setInput,
  });

  return {
    ...settingsCommand,
    action: (args?: string) => {
      const settingParts = args?.trim().split(/\s+/) ?? [];
      const settingKey = settingParts[0] === 'reset' ? settingParts[1] : settingParts[0];
      const hasHistory = messages.some((msg) => msg.sender !== 'system');
      if (settingKey === 'app.orchestratorMode' && hasHistory) {
        addSystemMessage(
          'Cannot switch modes mid-session (tool/context mismatch). Use `/clear` first, then change orchestrator mode.',
        );
        return true;
      }

      return settingsCommand.action(args);
    },
  };
}
