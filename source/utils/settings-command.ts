import type { SlashCommand } from '../slash-commands.js';
import { SETTINGS_RESET_TRIGGER, SETTINGS_TRIGGER } from '../components/input/triggers.js';
import type {
  SettingsService,
  SettingsWithSources,
  DurableWriteResult,
} from '../services/settings/settings-service.js';
import { SETTING_KEYS } from '../services/settings/settings-service.js';
import { getProvider } from '../providers/index.js';
import { parseModelProviderArg } from './ai/model-provider-arg.js';
import { getModelSettingConfig } from './ai/model-settings.js';

/**
 * Render the durable settlement of a mutation truthfully. Only a `saved`
 * result (or a caller that provided no settlement evidence) reports the
 * unqualified success line; a failed replacement is reported as memory-only so
 * the user is never told the value survived a restart.
 */
function formatDurableSetMessage(result: DurableWriteResult | undefined, key: string, value: unknown): string {
  if (result?.status === 'not-persisted') {
    if (result.reason === 'failed') {
      return `Error: failed to save ${key} to disk; the change is applied in memory only and will be lost on restart.`;
    }
    return `Set ${key} to ${value} (memory only - persistence is disabled).`;
  }
  return `Set ${key} to ${value}`;
}

function formatDurableResetMessage(result: DurableWriteResult | undefined, key: string): string {
  if (result?.status === 'not-persisted') {
    if (result.reason === 'failed') {
      return `Error: failed to save the reset of ${key} to disk; the reset is applied in memory only and will be lost on restart.`;
    }
    return `Reset ${key} to default (memory only - persistence is disabled).`;
  }
  return `Reset ${key} to default`;
}

export function parseSettingValue(raw: string): any {
  const value = raw.trim();

  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;

  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && value !== '') {
    return asNumber;
  }

  if ((value.startsWith('[') && value.endsWith(']')) || (value.startsWith('{') && value.endsWith('}'))) {
    try {
      return JSON.parse(value);
    } catch {
      // Preserve the original text so the settings schema can report a useful
      // validation error to the caller.
    }
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
      key: SETTING_KEYS.AGENT_MENTOR_SAMPLES,
      value: settings.agent.mentorSamples.value,
      source: settings.agent.mentorSamples.source,
    },
    {
      key: SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER,
      value: settings.agent.useFlexServiceTier.value,
      source: settings.agent.useFlexServiceTier.source,
    },
    {
      key: SETTING_KEYS.AGENT_CONTEXT_COMPACTION_ENABLED,
      value: settings.agent.contextCompaction.enabled.value,
      source: settings.agent.contextCompaction.enabled.source,
    },
    {
      key: SETTING_KEYS.AGENT_CONTEXT_COMPACTION_MODE,
      value: settings.agent.contextCompaction.mode.value,
      source: settings.agent.contextCompaction.mode.source,
    },
    {
      key: SETTING_KEYS.AGENT_CONTEXT_COMPACTION_COMPACT_THRESHOLD,
      value: settings.agent.contextCompaction.compactThreshold.value,
      source: settings.agent.contextCompaction.compactThreshold.source,
    },
    {
      key: SETTING_KEYS.AGENT_CONTEXT_COMPACTION_COMPACT_THRESHOLD_TOKENS,
      value: settings.agent.contextCompaction.compactThresholdTokens.value,
      source: settings.agent.contextCompaction.compactThresholdTokens.source,
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
      key: SETTING_KEYS.AGENT_RUN_BUDGET_MAX_USD_MICROS,
      value: settings.agent.runBudget.maxUsdMicros.value,
      source: settings.agent.runBudget.maxUsdMicros.source,
    },
    {
      key: SETTING_KEYS.AGENT_RUN_BUDGET_MAX_UNPRICED_TOKENS,
      value: settings.agent.runBudget.maxUnpricedTokens.value,
      source: settings.agent.runBudget.maxUnpricedTokens.source,
    },
    {
      key: SETTING_KEYS.AGENT_RUN_BUDGET_MAX_ACTIVE_TIME_MS,
      value: settings.agent.runBudget.maxActiveTimeMs.value,
      source: settings.agent.runBudget.maxActiveTimeMs.source,
    },
    {
      key: SETTING_KEYS.AGENT_RUN_BUDGET_WARNING_HEADROOM_USD_MICROS,
      value: settings.agent.runBudget.warningHeadroomUsdMicros.value,
      source: settings.agent.runBudget.warningHeadroomUsdMicros.source,
    },
    {
      key: SETTING_KEYS.AGENT_RUN_BUDGET_WARNING_HEADROOM_UNPRICED_TOKENS,
      value: settings.agent.runBudget.warningHeadroomUnpricedTokens.value,
      source: settings.agent.runBudget.warningHeadroomUnpricedTokens.source,
    },
    {
      key: SETTING_KEYS.AGENT_RUN_BUDGET_WARNING_HEADROOM_ACTIVE_TIME_MS,
      value: settings.agent.runBudget.warningHeadroomActiveTimeMs.value,
      source: settings.agent.runBudget.warningHeadroomActiveTimeMs.source,
    },
    {
      key: SETTING_KEYS.AGENT_RUN_BUDGET_SOFT_HEADROOM_USD_MICROS,
      value: settings.agent.runBudget.softHeadroomUsdMicros.value,
      source: settings.agent.runBudget.softHeadroomUsdMicros.source,
    },
    {
      key: SETTING_KEYS.AGENT_RUN_BUDGET_SOFT_HEADROOM_UNPRICED_TOKENS,
      value: settings.agent.runBudget.softHeadroomUnpricedTokens.value,
      source: settings.agent.runBudget.softHeadroomUnpricedTokens.source,
    },
    {
      key: SETTING_KEYS.AGENT_RUN_BUDGET_SOFT_HEADROOM_ACTIVE_TIME_MS,
      value: settings.agent.runBudget.softHeadroomActiveTimeMs.value,
      source: settings.agent.runBudget.softHeadroomActiveTimeMs.source,
    },
    {
      key: SETTING_KEYS.AGENT_RUN_BUDGET_TURN_BACKSTOP,
      value: settings.agent.runBudget.turnBackstop.value,
      source: settings.agent.runBudget.turnBackstop.source,
    },
    {
      key: SETTING_KEYS.AGENT_RUN_BUDGET_EXTENSION_PERCENT,
      value: settings.agent.runBudget.extensionPercent.value,
      source: settings.agent.runBudget.extensionPercent.source,
    },
    {
      key: SETTING_KEYS.AGENT_RUN_BUDGET_MAX_PARENT_EXTENSIONS,
      value: settings.agent.runBudget.maxParentExtensions.value,
      source: settings.agent.runBudget.maxParentExtensions.source,
    },
    {
      key: SETTING_KEYS.AGENT_RUN_BUDGET_IDENTICAL_TOOL_CALL_THRESHOLD,
      value: settings.agent.runBudget.identicalToolCallThreshold.value,
      source: settings.agent.runBudget.identicalToolCallThreshold.source,
    },
    {
      key: SETTING_KEYS.AGENT_RUN_BUDGET_ESCALATION,
      value: settings.agent.runBudget.escalation.value,
      source: settings.agent.runBudget.escalation.source,
    },
    {
      key: SETTING_KEYS.SHELL_TIMEOUT,
      value: settings.shell.timeout.value,
      source: settings.shell.timeout.source,
    },
    {
      key: SETTING_KEYS.SHELL_BACKGROUND_TIMEOUT,
      value: settings.shell.backgroundTimeout.value,
      source: settings.shell.backgroundTimeout.source,
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
      key: SETTING_KEYS.SUBAGENT_ASYNC_SESSION_TTL_MS,
      value: settings.subagent.asyncSessionTtlMs.value,
      source: settings.subagent.asyncSessionTtlMs.source,
    },
    {
      key: SETTING_KEYS.SUBAGENT_ASYNC_MESSAGE_CAP,
      value: settings.subagent.asyncMessageCap.value,
      source: settings.subagent.asyncMessageCap.source,
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
        const value = settingsService.getDynamic(key);
        const source = settingsService.getSource(key);
        addSystemMessage(`${key}: ${value} (${source})`);
        return true;
      }

      if (parts[0] === 'reset' && parts[1]) {
        const keyToReset = parts.slice(1).join(' ');
        const durableResult = settingsService.reset(keyToReset);
        addSystemMessage(formatDurableResetMessage(durableResult, keyToReset));

        // Apply runtime effects if applicable after reset
        const resetValue = settingsService.getDynamic(keyToReset);
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
          settingsService.setDynamic(providerKey, provider);
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

      if (key === SETTING_KEYS.AGENT_CONTEXT_COMPACTION_COMPACT_THRESHOLD_TOKENS && parsedValue !== null) {
        if (typeof parsedValue !== 'number' || !Number.isInteger(parsedValue) || parsedValue < 1000) {
          addSystemMessage(
            `Error: ${SETTING_KEYS.AGENT_CONTEXT_COMPACTION_COMPACT_THRESHOLD_TOKENS} must be null or a whole number greater than or equal to 1000`,
          );
          return true;
        }
      }

      // Trust roots are persisted startup configuration rather than a
      // runtime behavior toggle. Keep the write behind the settings service's
      // schema validation so roots cannot be stored as arbitrary values.
      if (key === SETTING_KEYS.HOOKS_TRUSTED_PROJECT_ROOTS) {
        if (!Array.isArray(parsedValue) || parsedValue.some((root) => typeof root !== 'string')) {
          addSystemMessage(`Error: ${key} must be a JSON array of paths`);
          return true;
        }
        const durableResult = settingsService.setPersistentDynamic(key, parsedValue);
        addSystemMessage(formatDurableSetMessage(durableResult, key, JSON.stringify(parsedValue)));
        return true;
      }

      if (!settingsService.isRuntimeModifiable(key)) {
        addSystemMessage(`Cannot modify '${key}' at runtime. Restart required.`);
        return true;
      }

      const planWas = Boolean(settingsService.get(SETTING_KEYS.APP_PLAN_MODE));
      const durableResult = settingsService.setDynamic(key, parsedValue);
      if (applyRuntimeSetting) {
        applyRuntimeSetting(key, parsedValue);
      }
      const planIs = Boolean(settingsService.get(SETTING_KEYS.APP_PLAN_MODE));
      if (applyRuntimeSetting && key !== SETTING_KEYS.APP_PLAN_MODE && planWas !== planIs) {
        applyRuntimeSetting(SETTING_KEYS.APP_PLAN_MODE, planIs);
      }
      addSystemMessage(formatDurableSetMessage(durableResult, key, parsedValue));
      if (key === SETTING_KEYS.AGENT_MAX_PARALLEL_TOOL_CALLS) {
        addSystemMessage('agent.maxParallelToolCalls takes effect on the next request.');
      }
      return true;
    },
  };
}
