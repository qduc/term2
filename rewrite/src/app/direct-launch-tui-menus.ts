/**
 * The data the ported legacy menus (clients/tui/menus/) read, served from the
 * same legacy services their source counterparts called. Session settings are
 * the attached session's live settings, never launch defaults.
 */
import {
  getSettingLabel,
  isKnownSettingKey,
  isSecretSetting,
} from '../../../source/services/settings/settings-ui-metadata.js';
import {
  SUBAGENT_POOL_SETTING_KEYS,
  getSubagentPoolEntryShape,
  getSubagentPoolRoleLabel,
} from '../../../source/services/subagents/subagent-pool-config.js';
import type { TuiMenus } from '../clients/tui/integration.js';

export function createDirectTuiMenus(): TuiMenus {
  return {
    schema: {
      isKnownSettingKey,
      label: getSettingLabel,
      isSecret: isSecretSetting,
      subagentPool: (key) =>
        SUBAGENT_POOL_SETTING_KEYS.has(key)
          ? { roleLabel: getSubagentPoolRoleLabel(key), entryShape: getSubagentPoolEntryShape(key) }
          : undefined,
    },
  };
}
