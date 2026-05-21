import { useCallback } from 'react';
import type { ConversationService } from '../services/conversation-service.js';
import type { SettingsService } from '../services/settings-service.js';
import { setTrimConfig } from '../utils/output-trim.js';
import { planModeNotice } from '../services/mode-notices.js';

interface UseRuntimeSettingsProps {
  setModel: (model: string) => void;
  setReasoningEffort: (effort: any) => void;
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
    (key: string, value: any) => {
      if (key === 'agent.model') {
        setModel(String(value));
        return;
      }

      if (key === 'agent.reasoningEffort') {
        setReasoningEffort(value);
        return;
      }

      if (key === 'agent.temperature') {
        // Settings command parses numbers already; coerce just in case.
        if (value == null) {
          setTemperature(undefined);
          return;
        }
        const numeric = typeof value === 'number' ? value : Number(value);
        setTemperature(Number.isFinite(numeric) ? numeric : undefined);
        return;
      }

      if (key === 'agent.provider') {
        // Provider changes require the agent to be recreated, which happens
        // via the conversation service's setProvider method
        const setProviderFn = (conversationService as any).setProvider;
        if (typeof setProviderFn === 'function') {
          setProviderFn.call(conversationService, value);
        }
        return;
      }

      if (key === 'agent.mentorModel' || key === 'agent.mentorProvider' || key === 'agent.mentorReasoningEffort') {
        // Re-initialize the current model to refresh tools (in case mentor availability or config changes)
        const currentModel = settingsService.get<string>('agent.model');
        setModel(currentModel);
        return;
      }

      if (key === 'app.mentorMode') {
        // Exclusivity enforcement is owned by the slash-command handlers.
        // Here we only apply the side-effect: re-initialize agent prompt/tools.
        const currentModel = settingsService.get<string>('agent.model');
        setModel(currentModel);
        return;
      }

      if (key === 'app.liteMode') {
        // Exclusivity enforcement is owned by the slash-command handlers.
        // Here we only apply the side-effect: re-initialize agent prompt/tools.
        const currentModel = settingsService.get<string>('agent.model');
        setModel(currentModel);
        return;
      }

      if (key === 'app.planMode') {
        // Exclusivity enforcement is owned by the slash-command handlers.
        conversationService.queueModeNotice(planModeNotice(Boolean(value)));
        return;
      }

      if (key === 'app.orchestratorMode') {
        // Exclusivity enforcement is owned by the slash-command handlers.
        const currentModel = settingsService.get<string>('agent.model');
        setModel(currentModel);
        return;
      }

      if (key === 'shell.autoApproveMode') {
        // No runtime changes needed, session reads from settingsService
        return;
      }

      if (key === 'shell.maxOutputLines') {
        setTrimConfig({ maxLines: Number(value) });
        return;
      }

      if (key === 'shell.maxOutputChars') {
        setTrimConfig({ maxCharacters: Number(value) });
      }
    },
    [setModel, setReasoningEffort, setTemperature, conversationService, settingsService],
  );
};
