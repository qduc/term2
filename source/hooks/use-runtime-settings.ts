import { useCallback } from 'react';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import type { ConversationService } from '../services/conversation/conversation-service.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { applyRuntimeSettingChange } from '../services/runtime-setting-router.js';

interface UseRuntimeSettingsProps {
  setModel: (model: string) => void;
  setReasoningEffort: (effort: ReasoningEffortSetting) => void;
  setTemperature: (temp: number | undefined) => void;
  conversationService: ConversationService;
  settingsService: SettingsService;
}

export const useRuntimeSettings = ({
  setModel,
  setReasoningEffort,
  setTemperature,
  conversationService,
  settingsService,
}: UseRuntimeSettingsProps) => {
  return useCallback(
    (key: string, value: unknown) =>
      applyRuntimeSettingChange(key, value, {
        conversationService,
        settingsService,
        setModel,
        setReasoningEffort,
        setTemperature,
      }),
    [setModel, setReasoningEffort, setTemperature, conversationService, settingsService],
  );
};
