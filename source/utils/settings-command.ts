import type {SlashCommand} from '../components/SlashCommandMenu.js';
import type {
	SettingsService,
	SettingsWithSources,
} from '../services/settings-service.js';

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
		{key: 'agent.model', value: settings.agent.model.value, source: settings.agent.model.source},
		{
			key: 'agent.reasoningEffort',
			value: settings.agent.reasoningEffort.value,
			source: settings.agent.reasoningEffort.source,
		},
		{key: 'agent.maxTurns', value: settings.agent.maxTurns.value, source: settings.agent.maxTurns.source},
		{
			key: 'agent.retryAttempts',
			value: settings.agent.retryAttempts.value,
			source: settings.agent.retryAttempts.source,
		},
		{key: 'shell.timeout', value: settings.shell.timeout.value, source: settings.shell.timeout.source},
		{
			key: 'shell.maxOutputLines',
			value: settings.shell.maxOutputLines.value,
			source: settings.shell.maxOutputLines.source,
		},
		{
			key: 'shell.maxOutputChars',
			value: settings.shell.maxOutputChars.value,
			source: settings.shell.maxOutputChars.source,
		},
		{key: 'ui.historySize', value: settings.ui.historySize.value, source: settings.ui.historySize.source},
		{key: 'logging.logLevel', value: settings.logging.logLevel.value, source: settings.logging.logLevel.source},
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
	setInput?: (value: string) => void;
}

export function createSettingsCommand({
	settingsService,
	addSystemMessage,
	applyRuntimeSetting,
}: CreateSettingsCommandDeps): SlashCommand {
	return {
		name: 'settings',
		description: 'View or modify settings',
		expectsArgs: true,
		action: (args?: string) => {
			const trimmedArgs = args?.trim() ?? '';

			// No args: show all settings
			if (!trimmedArgs) {
				const all = settingsService.getAll();
				addSystemMessage(formatSettingsSummary(all));
				return true;
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
				return true;
			}

			const key = parts[0];
			const rawValue = parts.slice(1).join(' ');
			const parsedValue = parseSettingValue(rawValue);

			if (!settingsService.isRuntimeModifiable(key)) {
				addSystemMessage(`Cannot modify '${key}' at runtime. Restart required.`);
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
