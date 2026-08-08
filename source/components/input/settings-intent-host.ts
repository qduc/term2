import type { SettingsService } from '../../services/settings/settings-service.js';
import type {
  ConversationConfigurationService,
  ConversationSettingChange,
} from '../../services/runtime-setting-router.js';
import type { IntentRequest, IntentResult } from './menu-types.js';

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
    try {
      if (configurationService) {
        configurationService.apply(intent.changes as readonly ConversationSettingChange[]);
      } else {
        for (const change of intent.changes) {
          if (change.persistence === 'runtime') settingsService.setDynamic(change.key, change.value);
          else settingsService.setPersistentDynamic(change.key, change.value);
        }
      }
      for (const change of intent.changes) {
        if (change.persistence === 'runtime') onSettingChange?.(change.key, change.value);
        else onSystemMessage?.(`Saved ${change.key} = ${change.value}. This setting applies after restart.`);
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
      onSystemMessage?.(`Reset ${intent.key} to default`);
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
