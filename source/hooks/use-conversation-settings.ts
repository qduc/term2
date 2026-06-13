import { useCallback } from 'react';
import type { ConversationService } from '../services/conversation/conversation-service.js';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';

export interface UseConversationSettingsParams {
  conversationService: ConversationService;
}

export interface UseConversationSettingsReturn {
  setModel: (model: string) => void;
  setReasoningEffort: (effort: ReasoningEffortSetting) => void;
  setTemperature: (temperature?: number) => void;
}

/**
 * Sub-hook to delegate settings management to ConversationService.
 *
 * Provides callbacks for setModel, setReasoningEffort, and setTemperature.
 */
export function useConversationSettings({
  conversationService,
}: UseConversationSettingsParams): UseConversationSettingsReturn {
  const setModel = useCallback(
    (model: string) => {
      conversationService.setModel(model);
    },
    [conversationService],
  );

  const setReasoningEffort = useCallback(
    (effort: ReasoningEffortSetting) => {
      conversationService.setReasoningEffort(effort);
    },
    [conversationService],
  );

  const setTemperature = useCallback(
    (temperature?: number) => {
      conversationService.setTemperature(temperature);
    },
    [conversationService],
  );

  return {
    setModel,
    setReasoningEffort,
    setTemperature,
  };
}
