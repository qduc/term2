import type { SettingsService } from '../../services/settings/settings-service.js';
import type {
  ConversationConfigurationService,
  ConversationSettingChange,
} from '../../services/runtime-setting-router.js';
import type { IntentRequest, IntentResult } from './menu-types.js';
import { formatSettingValueDetail } from '../menu/settings-value-formatter.js';
import { getSettingLabel, isKnownSettingKey } from '../../services/settings/settings-ui-metadata.js';
import { SETTING_ENV_VARIABLES } from '../../services/settings/settings-env.js';

/** Why a saved value will not survive the next launch, if something overrides it. */
function startupOverrideNote(settingsService: SettingsService, key: string): string | undefined {
  const source = settingsService.getStartupOverride(key);
  if (!source) return undefined;
  const who =
    source === 'env'
      ? SETTING_ENV_VARIABLES[key]
        ? `$${SETTING_ENV_VARIABLES[key]}`
        : 'an environment variable'
      : 'a command-line flag';
  return `${who} also sets it and wins again at the next launch.`;
}

export type SettingsIntentHostDeps = {
  settingsService: SettingsService;
  onSettingChange?: (key: string, value: unknown) => void;
  onSystemMessage?: (text: string) => void;
  applyRuntimeSetting?: (key: string, value: unknown) => void;
  configurationService?: ConversationConfigurationService;
};

/**
 * Handles the `apply-settings` and `reset-setting` domain intents produced by
 * the settings / settings-value / model controller graph. Returns `undefined`
 * for any other intent type so a caller (the application effect host) can
 * compose this with handlers for other domains (rewind, provider, ...).
 *
 * This is a pure-ish module (its only side effects are the settings service
 * calls and the injected callbacks) so it can be exercised directly by tests
 * that mount `InputBox` without the rest of the application shell.
 */
export function handleSettingsIntent(request: IntentRequest, deps: SettingsIntentHostDeps): IntentResult | undefined {
  const { settingsService, onSettingChange, onSystemMessage, applyRuntimeSetting, configurationService } = deps;
  const { id, sourceFrameId, intent } = request;

  if (intent.type === 'apply-settings') {
    const fieldErrors: Record<string, string> = {};
    // The service silently drops a key the schema does not know, so an unknown
    // key must be refused here rather than reported as saved.
    for (const change of intent.changes) {
      if (!isKnownSettingKey(change.key)) fieldErrors[change.key] = `Unknown setting "${change.key}"`;
    }
    if (Object.keys(fieldErrors).length > 0) {
      return { id, sourceFrameId, ok: false, message: 'Unknown setting.', fieldErrors };
    }
    try {
      if (configurationService) {
        configurationService.apply(intent.changes as readonly ConversationSettingChange[]);
      } else {
        for (const change of intent.changes) {
          if (change.persistence === 'runtime') settingsService.setDynamic(change.key, change.value);
          else settingsService.setPersistentDynamic(change.key, change.value);
        }
      }
      // `disabled` persistence (tests, --no-save style runs) is intentional;
      // only a failed write means the user's change was lost.
      const lastWrite = settingsService.getLastDurableWrite();
      const saved = !(lastWrite?.status === 'not-persisted' && lastWrite.reason === 'failed');
      for (const change of intent.changes) {
        const label = getSettingLabel(change.key);
        const valueText = formatSettingValueDetail(change.key, change.value);
        const note = startupOverrideNote(settingsService, change.key);
        if (change.persistence === 'runtime') {
          onSettingChange?.(change.key, change.value);
          if (!saved) onSystemMessage?.(`${label} set to ${valueText} for this session; it could not be saved.`);
          else if (note) onSystemMessage?.(`${label} set to ${valueText}. Note: ${note}`);
        } else {
          onSystemMessage?.(
            saved
              ? `Saved ${label} = ${valueText}. Restart term2 for it to take effect.${note ? ` Note: ${note}` : ''}`
              : `Could not save ${label} = ${valueText} to the settings file.`,
          );
        }
      }
    } catch (err) {
      for (const change of intent.changes) fieldErrors[change.key] = err instanceof Error ? err.message : String(err);
    }
    if (Object.keys(fieldErrors).length > 0) {
      return {
        id,
        sourceFrameId,
        ok: false,
        message: 'Failed to apply one or more setting changes.',
        fieldErrors,
      };
    }
    return { id, sourceFrameId, ok: true };
  }

  if (intent.type === 'reset-setting') {
    try {
      if (configurationService) configurationService.reset(intent.key);
      else settingsService.reset(intent.key);
      onSystemMessage?.(`Reset ${getSettingLabel(intent.key)} to default`);
      if (!configurationService && applyRuntimeSetting && settingsService.isRuntimeModifiable(intent.key)) {
        applyRuntimeSetting(intent.key, settingsService.getDynamic(intent.key));
      }
      return { id, sourceFrameId, ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { id, sourceFrameId, ok: false, message, fieldErrors: { [intent.key]: message } };
    }
  }

  return undefined;
}
