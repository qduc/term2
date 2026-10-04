import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { getProvider } from '../providers/index.js';
import { parseModelProviderArg } from '../utils/ai/model-provider-arg.js';
import { MODEL_CMD_TRIGGER } from '../utils/ai/model-settings.js';

interface CreateModelSlashCommandDeps {
  settingsService: SettingsService;
  applyRuntimeSetting: (key: string, value: any) => void;
  addSystemMessage: (text: string) => void;
  replaceInput: (input: string) => void;
}

export function createModelSlashCommand({
  settingsService,
  applyRuntimeSetting,
  addSystemMessage,
  replaceInput,
}: CreateModelSlashCommandDeps): SlashCommand {
  return {
    name: 'model',
    description: 'Choose or set the AI model (Ctrl+O; use /model <model-id>)',
    expectsArgs: true,
    completion: { type: 'model', trigger: MODEL_CMD_TRIGGER },
    action: (args?: string) => {
      if (!args) {
        replaceInput('/model ');
        return false;
      }

      const { modelId, provider } = parseModelProviderArg(args);

      if (provider) {
        if (!getProvider(provider)) {
          addSystemMessage(`Error: Unknown provider '${provider}'`);
          return false;
        }
      }

      const selection = { model: modelId, provider: provider ?? settingsService.get('agent.modelSelection').provider };
      settingsService.set('agent.modelSelection', selection);
      applyRuntimeSetting('agent.modelSelection', selection);
      const providerMsg = ` (${selection.provider})`;

      addSystemMessage(`Set model to ${modelId}${providerMsg}`);

      return true;
    },
  };
}
