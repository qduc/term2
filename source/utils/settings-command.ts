import type { SlashCommand } from '../slash-commands.js';
import { SETTINGS_RESET_TRIGGER, SETTINGS_TRIGGER } from '../components/input/triggers.js';
import type { SettingsService, SettingsWithSources } from '../services/settings/settings-service.js';
import { SETTING_KEYS } from '../services/settings/settings-service.js';
import { getProvider } from '../providers/index.js';
import { parseModelProviderArg } from './ai/model-provider-arg.js';
import { getModelSettingConfig } from './ai/model-settings.js';

export function parseSettingValue(raw: string): any {
  const value = raw.trim();

  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;

  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && value !== '') {
    return asNumber;
  }

  return value;
}

export function formatSettingsSummary(settings: SettingsWithSources): string {
  const lines: string[] = [];
  const entries: Array<{ key: string; value: any; source: string }> = [
    {
      key: SETTING_KEYS.AGENT_MODEL,
      value: settings.agent.model.value,
      source: settings.agent.model.source,
    },
    {
      key: SETTING_KEYS.AGENT_EFFICIENT_MODEL,
      value: settings.agent.efficientModel.value,
      source: settings.agent.efficientModel.source,
    },
    {
      key: SETTING_KEYS.AGENT_CAPABLE_MODEL,
      value: settings.agent.capableModel.value,
      source: settings.agent.capableModel.source,
    },
    {
      key: SETTING_KEYS.AGENT_REASONING_EFFORT,
      value: settings.agent.reasoningEffort.value,
      source: settings.agent.reasoningEffort.source,
    },
    {
      key: SETTING_KEYS.AGENT_TEMPERATURE,
      value: settings.agent.temperature.value,
      source: settings.agent.temperature.source,
    },
    {
      key: SETTING_KEYS.AGENT_MENTOR_MODEL,
      value: settings.agent.mentorModel.value,
      source: settings.agent.mentorModel.source,
    },
    {
      key: SETTING_KEYS.AGENT_MENTOR_PROVIDER,
      value: settings.agent.mentorProvider.value,
      source: settings.agent.mentorProvider.source,
    },
    {
      key: SETTING_KEYS.AGENT_MENTOR_REASONING_EFFORT,
      value: settings.agent.mentorReasoningEffort.value,
      source: settings.agent.mentorReasoningEffort.source,
    },
    {
      key: SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER,
      value: settings.agent.useFlexServiceTier.value,
      source: settings.agent.useFlexServiceTier.source,
    },
    // agent.provider is hidden - it can only be changed in a new conversation via model menu
    {
      key: SETTING_KEYS.AGENT_MAX_TURNS,
      value: settings.agent.maxTurns.value,
      source: settings.agent.maxTurns.source,
    },
    {
      key: SETTING_KEYS.AGENT_RETRY_ATTEMPTS,
      value: settings.agent.retryAttempts.value,
      source: settings.agent.retryAttempts.source,
    },
    {
      key: SETTING_KEYS.AGENT_TRANSPORT,
      value: settings.agent.transport.value,
      source: settings.agent.transport.source,
    },
    {
      key: SETTING_KEYS.AGENT_MAX_PARALLEL_TOOL_CALLS,
      value: settings.agent.maxParallelToolCalls.value,
      source: settings.agent.maxParallelToolCalls.source,
    },
    {
      key: SETTING_KEYS.SHELL_TIMEOUT,
      value: settings.shell.timeout.value,
      source: settings.shell.timeout.source,
    },
    {
      key: SETTING_KEYS.SHELL_MAX_OUTPUT_LINES,
      value: settings.shell.maxOutputLines.value,
      source: settings.shell.maxOutputLines.source,
    },
    {
      key: SETTING_KEYS.SHELL_MAX_OUTPUT_CHARS,
      value: settings.shell.maxOutputChars.value,
      source: settings.shell.maxOutputChars.source,
    },
    {
      key: SETTING_KEYS.UI_HISTORY_SIZE,
      value: settings.ui.historySize.value,
      source: settings.ui.historySize.source,
    },
    {
      key: SETTING_KEYS.LOGGING_LOG_LEVEL,
      value: settings.logging.logLevel.value,
      source: settings.logging.logLevel.source,
    },
    {
      key: SETTING_KEYS.MEMORY_ENABLED,
      value: settings.memory.enabled.value,
      source: settings.memory.enabled.source,
    },
  ];

  for (const entry of entries) {
    lines.push(`${entry.key}: ${entry.value} (${entry.source})`);
  }

  return lines.join('\n');
}

interface CreateSettingsCommandDeps {
  settingsService: SettingsService;
  addSystemMessage: (message: string) => void;
  applyRuntimeSetting?: (key: string, value: any) => void;
  replaceInput: (value: string) => void;
}

export function createSettingsCommand({
  settingsService,
  addSystemMessage,
  applyRuntimeSetting,
  replaceInput,
}: CreateSettingsCommandDeps): SlashCommand {
  return {
    name: 'settings',
    description: 'View or modify settings',
    expectsArgs: true,
    completion: { type: 'settings', trigger: SETTINGS_TRIGGER, resetTrigger: SETTINGS_RESET_TRIGGER },
    action: (args?: string) => {
      const trimmedArgs = args?.trim() ?? '';

      // No args: prompt for setting name with autocomplete
      if (!trimmedArgs) {
        replaceInput('/settings ');
        return false;
      }

      const parts = trimmedArgs.split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        const key = parts[0];
        const value = settingsService.get(key);
        const source = settingsService.getSource(key);
        addSystemMessage(`${key}: ${value} (${source})`);
        return true;
      }

      if (parts[0] === 'reset' && parts[1]) {
        const keyToReset = parts.slice(1).join(' ');
        settingsService.reset(keyToReset);
        addSystemMessage(`Reset ${keyToReset} to default`);

        // Apply runtime effects if applicable after reset
        const resetValue = settingsService.get(keyToReset);
        if (applyRuntimeSetting && settingsService.isRuntimeModifiable(keyToReset)) {
          applyRuntimeSetting(keyToReset, resetValue);
        }
        if (keyToReset === SETTING_KEYS.AGENT_MAX_PARALLEL_TOOL_CALLS) {
          addSystemMessage('agent.maxParallelToolCalls takes effect on the next request.');
        }
        return true;
      }

      const key = parts[0];
      const rawValue = parts.slice(1).join(' ');
      let parsedValue = parseSettingValue(rawValue);

      // Special handling for model settings: handle --provider flag and save
      // the associated provider setting.
      const modelSettingConfig = getModelSettingConfig(key);
      if (modelSettingConfig && typeof parsedValue === 'string') {
        const { modelId, provider } = parseModelProviderArg(parsedValue);
        if (provider) {
          // Validate provider
          if (!getProvider(provider)) {
            addSystemMessage(`Error: Unknown provider '${provider}'`);
            return false;
          }
          // Update provider setting
          const providerKey = modelSettingConfig.providerKey;
          settingsService.set(providerKey, provider);
          // Apply runtime provider change
          if (applyRuntimeSetting) {
            applyRuntimeSetting(providerKey, provider);
          }
        }
        parsedValue = modelId;
      }

      // Prevent changing provider via settings command - it can only be changed
      // at the start of a new conversation via the model selection menu
      if (key === 'agent.provider') {
        addSystemMessage(
          `Cannot change provider mid-conversation. Use the model menu (Tab to switch provider) at the start of a new conversation.`,
        );
        return true;
      }

      // Validate temperature values early for a nicer UX.
      if (key === SETTING_KEYS.AGENT_TEMPERATURE) {
        if (typeof parsedValue !== 'number' || !Number.isFinite(parsedValue)) {
          addSystemMessage(`Error: ${SETTING_KEYS.AGENT_TEMPERATURE} must be a number between 0 and 2`);
          return true;
        }
        if (parsedValue < 0 || parsedValue > 2) {
          addSystemMessage(`Error: ${SETTING_KEYS.AGENT_TEMPERATURE} must be between 0 and 2`);
          return true;
        }
      }

      if (key === SETTING_KEYS.AGENT_MAX_PARALLEL_TOOL_CALLS) {
        if (typeof parsedValue !== 'number' || !Number.isInteger(parsedValue) || parsedValue < 1) {
          addSystemMessage(
            `Error: ${SETTING_KEYS.AGENT_MAX_PARALLEL_TOOL_CALLS} must be a whole number greater than or equal to 1`,
          );
          return true;
        }
      }

      if (!settingsService.isRuntimeModifiable(key)) {
        addSystemMessage(`Cannot modify '${key}' at runtime. Restart required.`);
        return true;
      }

      settingsService.set(key, parsedValue);
      if (applyRuntimeSetting) {
        applyRuntimeSetting(key, parsedValue);
      }
      addSystemMessage(`Set ${key} to ${parsedValue}`);
      if (key === SETTING_KEYS.AGENT_MAX_PARALLEL_TOOL_CALLS) {
        addSystemMessage('agent.maxParallelToolCalls takes effect on the next request.');
      }
      return true;
    },
  };
}
