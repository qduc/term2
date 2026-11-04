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
import {
  getWorkspaceEntries,
  getWorkspaceEntriesMeta,
  refreshWorkspaceEntries,
} from '../../../source/services/file-service.js';
import type { LoggingService } from '../../../source/services/logging/logging-service.js';
import type { TuiMenus } from '../clients/tui/integration.js';

export function createDirectTuiMenus(options: { readonly logger: LoggingService }): TuiMenus {
  const { logger } = options;
  return {
    logger: {
      warn: (message, details) => logger.warn(message, details),
      error: (message, details) => logger.error(message, details),
    },
    paths: {
      entries: getWorkspaceEntries,
      refresh: refreshWorkspaceEntries,
      meta: getWorkspaceEntriesMeta,
    },
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
