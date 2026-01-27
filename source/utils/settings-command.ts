import type {SlashCommand} from '../components/SlashCommandMenu.js';
import type {
    SettingsService,
    SettingsWithSources,
} from '../services/settings-service.js';
import {SETTING_KEYS} from '../services/settings-service.js';
import {getProvider} from '../providers/index.js';

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
    const entries: Array<{key: string; value: any; source: string}> = [
        {
            key: SETTING_KEYS.AGENT_MODEL,
            value: settings.agent.model.value,
            source: settings.agent.model.source,
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
    setInput: (value: string) => void;
}

export function createSettingsCommand({
    settingsService,
    addSystemMessage,
    applyRuntimeSetting,
    setInput,
}: CreateSettingsCommandDeps): SlashCommand {
    return {
        name: 'settings',
        description: 'View or modify settings',
        expectsArgs: true,
        action: (args?: string) => {
            const trimmedArgs = args?.trim() ?? '';

            // No args: prompt for setting name with autocomplete
            if (!trimmedArgs) {
                setInput('/settings ');
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
                if (
                    applyRuntimeSetting &&
                    settingsService.isRuntimeModifiable(keyToReset)
                ) {
                    applyRuntimeSetting(keyToReset, resetValue);
                }
                return true;
            }

            const key = parts[0];
            const rawValue = parts.slice(1).join(' ');
            let parsedValue = parseSettingValue(rawValue);

            // Special handling for agent.model / agent.mentorModel: handle --provider flag
            if (
                (key === SETTING_KEYS.AGENT_MODEL ||
                    key === SETTING_KEYS.AGENT_MENTOR_MODEL) &&
                typeof parsedValue === 'string'
            ) {
                const providerMatch = parsedValue.match(/--provider=(\w+)/);
                if (providerMatch) {
                    const provider = providerMatch[1];
                    // Validate provider
                    if (!getProvider(provider)) {
                        addSystemMessage(
                            `Error: Unknown provider '${provider}'`,
                        );
                        return false;
                    }
                    // Update provider setting
                    const providerKey =
                        key === SETTING_KEYS.AGENT_MENTOR_MODEL
                            ? SETTING_KEYS.AGENT_MENTOR_PROVIDER
                            : SETTING_KEYS.AGENT_PROVIDER;
                    settingsService.set(providerKey, provider);
                    // Apply runtime provider change
                    if (applyRuntimeSetting) {
                        applyRuntimeSetting(providerKey, provider);
                    }
                }
                parsedValue = parsedValue
                    .replace(/\s*--provider=\w+\s*/, '')
                    .trim();
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
                if (
                    typeof parsedValue !== 'number' ||
                    !Number.isFinite(parsedValue)
                ) {
                    addSystemMessage(
                        `Error: ${SETTING_KEYS.AGENT_TEMPERATURE} must be a number between 0 and 2`,
                    );
                    return true;
                }
                if (parsedValue < 0 || parsedValue > 2) {
                    addSystemMessage(
                        `Error: ${SETTING_KEYS.AGENT_TEMPERATURE} must be between 0 and 2`,
                    );
                    return true;
                }
            }

            if (!settingsService.isRuntimeModifiable(key)) {
                addSystemMessage(
                    `Cannot modify '${key}' at runtime. Restart required.`,
                );
                return true;
            }

            settingsService.set(key, parsedValue);
            if (applyRuntimeSetting) {
                applyRuntimeSetting(key, parsedValue);
            }
            addSystemMessage(`Set ${key} to ${parsedValue}`);
            return true;
        },
    };
}
