import { useCallback, useMemo } from 'react';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import type { RuntimeSettingRouterConversationService } from '../services/runtime-setting-router.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { ConversationConfigurationService } from '../services/runtime-setting-router.js';

interface UseRuntimeSettingsProps {
  setModel: (model: string) => void;
  setReasoningEffort: (effort: ReasoningEffortSetting) => void;
  setTemperature: (temp: number | undefined) => void;
  conversationService: RuntimeSettingRouterConversationService;
  settingsService: SettingsService;
}

export const useRuntimeSettings = ({
  setModel,
  setReasoningEffort,
  setTemperature,
  conversationService,
  settingsService,
}: UseRuntimeSettingsProps) => {
  const configurationService = useMemo(
    () =>
      new ConversationConfigurationService({
        conversationService,
        settingsService,
        setModel,
        setReasoningEffort,
        setTemperature,
      }),
    [setModel, setReasoningEffort, setTemperature, conversationService, settingsService],
  );
  return useCallback(
    (key: string, value: unknown) => configurationService.applyRuntimeSetting(key, value),
    [configurationService],
  );
};
