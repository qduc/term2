import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings-service.js';
import { getProvider } from '../providers/index.js';
import { parseModelProviderArg } from '../utils/model-provider-arg.js';
import { MODEL_CMD_TRIGGER } from '../utils/model-settings.js';

interface CreateModelSlashCommandDeps {
  settingsService: SettingsService;
  applyRuntimeSetting: (key: string, value: any) => void;
  addSystemMessage: (text: string) => void;
  setInput: (input: string) => void;
}

export function createModelSlashCommand({
  settingsService,
  applyRuntimeSetting,
  addSystemMessage,
  setInput,
}: CreateModelSlashCommandDeps): SlashCommand {
  return {
    name: 'model',
    description: 'Change the AI model (e.g. /model gpt-4)',
    expectsArgs: true,
    completion: { type: 'model', trigger: MODEL_CMD_TRIGGER },
    action: (args?: string) => {
      if (!args) {
        setInput('/model ');
        return false;
      }

      const { modelId, provider } = parseModelProviderArg(args);

      if (provider) {
        if (!getProvider(provider)) {
          addSystemMessage(`Error: Unknown provider '${provider}'`);
          return false;
        }
      }

      settingsService.set('agent.model', modelId);
      applyRuntimeSetting('agent.model', modelId);

      let providerMsg = '';
      if (provider) {
        settingsService.set('agent.provider', provider);
        applyRuntimeSetting('agent.provider', provider);
        providerMsg = ` (${provider})`;
      }

      addSystemMessage(`Set model to ${modelId}${providerMsg}`);

      return true;
    },
  };
}
