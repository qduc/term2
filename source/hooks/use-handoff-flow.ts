import { useCallback, useEffect, useRef, useState } from 'react';
import { parseInput } from '../utils/input-parser.js';
import { parseModelProviderArg } from '../utils/ai/model-provider-arg.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import type { UserTurn } from '../types/user-turn.js';
import type { InputMode } from '../context/InputContext.js';

export type HandoffStage = 'entering_message' | 'confirm_model' | 'selecting_model' | 'confirm_standard_mode';

export interface HandoffState {
  capturedText: string;
  stage: HandoffStage;
  handoffMessage?: string;
}

export type UseHandoffFlowOptions = {
  clearConversationAndRefreshBanner: () => Promise<void>;
  addSystemMessage: (text: string) => void;
  sendUserMessage: (turn: UserTurn) => Promise<void>;
  setInput: (value: string) => void;
  setMode: (mode: InputMode) => void;
  setTriggerIndex: (index: number | null) => void;
  mode: string;
  settingsService: SettingsService;
  applyRuntimeSetting: (key: string, value: unknown) => void;
  setModel: (model: string) => void;
};

export type UseHandoffFlowReturn = {
  handoffState: HandoffState | null;
  startHandoff: (capturedText: string) => void;
  confirmHandoff: () => Promise<void>;
  declineHandoff: () => Promise<void>;
  cancelHandoff: () => void;
  submitHandoffInput: (turn: UserTurn) => Promise<boolean>;
  confirmStandardMode: () => Promise<void>;
  declineStandardMode: () => Promise<void>;
};

const MODEL_TRIGGER = '/model ';

export const useHandoffFlow = ({
  clearConversationAndRefreshBanner,
  addSystemMessage,
  sendUserMessage,
  setInput,
  setMode,
  setTriggerIndex,
  mode,
  settingsService,
  applyRuntimeSetting,
  setModel,
}: UseHandoffFlowOptions): UseHandoffFlowReturn => {
  const [handoffState, setHandoffState] = useState<HandoffState | null>(null);
  const selectedModelSendInFlightRef = useRef(false);

  const sendCapturedHandoff = useCallback(
    async (state: HandoffState) => {
      if (selectedModelSendInFlightRef.current) {
        return false;
      }

      selectedModelSendInFlightRef.current = true;
      try {
        const isPlanMode = settingsService.get<boolean>('app.planMode') || false;
        if (isPlanMode) {
          setHandoffState({
            ...state,
            stage: 'confirm_standard_mode',
          });
          setInput('');
          return true;
        }

        setHandoffState(null);
        setInput('');
        const handoffMsg = state.handoffMessage || 'Implement this';
        await sendUserMessage({ text: `${handoffMsg}:\n\n${state.capturedText}` });
        return true;
      } finally {
        selectedModelSendInFlightRef.current = false;
      }
    },
    [sendUserMessage, setInput, settingsService],
  );

  const sendSelectedModelHandoff = useCallback(
    async (state: HandoffState, turn: UserTurn) => {
      if (selectedModelSendInFlightRef.current) {
        return false;
      }

      selectedModelSendInFlightRef.current = true;
      try {
        const parsedInput = parseInput(turn.text);
        const modelArg = parsedInput.type === 'slash-command' ? parsedInput.args : turn.text;
        const { modelId, provider } = parseModelProviderArg(modelArg);

        if (modelId) {
          settingsService.set('agent.model', modelId);
          if (provider) {
            settingsService.set('agent.provider', provider);
            applyRuntimeSetting('agent.provider', provider);
          }
          applyRuntimeSetting('agent.model', modelId);
          setModel(modelId);
        }

        const isPlanMode = settingsService.get<boolean>('app.planMode') || false;
        if (isPlanMode) {
          setHandoffState({
            ...state,
            stage: 'confirm_standard_mode',
          });
          setInput('');
          return true;
        }

        setHandoffState(null);
        setInput('');
        const handoffMsg = state.handoffMessage || 'Implement this';
        await sendUserMessage({ text: `${handoffMsg}:\n\n${state.capturedText}` });
        return true;
      } finally {
        selectedModelSendInFlightRef.current = false;
      }
    },
    [applyRuntimeSetting, sendUserMessage, setInput, setModel, settingsService],
  );

  useEffect(() => {
    if (mode !== 'text') return;
    if (handoffState?.stage !== 'selecting_model') return;

    void sendCapturedHandoff(handoffState);
  }, [handoffState, mode, sendCapturedHandoff]);

  const startHandoff = useCallback((capturedText: string) => {
    setHandoffState({ capturedText, stage: 'entering_message' });
  }, []);

  const confirmHandoff = useCallback(async () => {
    if (!handoffState) return;

    await clearConversationAndRefreshBanner();
    setHandoffState((prev) => (prev ? { ...prev, stage: 'selecting_model' } : null));
    setInput(MODEL_TRIGGER);
    setMode('model_selection');
    setTriggerIndex(MODEL_TRIGGER.length);
  }, [clearConversationAndRefreshBanner, handoffState, setInput, setMode, setTriggerIndex]);

  const declineHandoff = useCallback(async () => {
    const state = handoffState;
    if (!state) return;

    const text = state.capturedText;
    const handoffMsg = state.handoffMessage || 'Implement this';

    const isPlanMode = settingsService.get<boolean>('app.planMode') || false;
    if (isPlanMode) {
      await clearConversationAndRefreshBanner();
      setHandoffState((prev) => (prev ? { ...prev, stage: 'confirm_standard_mode' } : null));
      setInput('');
      return;
    }

    await clearConversationAndRefreshBanner();
    setHandoffState(null);
    setInput('');
    if (text) {
      await sendUserMessage({ text: `${handoffMsg}:\n\n${text}` });
    }
  }, [clearConversationAndRefreshBanner, handoffState, sendUserMessage, setInput, settingsService]);

  const cancelHandoff = useCallback(() => {
    setHandoffState(null);
    setInput('');
    addSystemMessage('Handoff cancelled');
  }, [addSystemMessage, setInput]);

  const confirmStandardMode = useCallback(async () => {
    const state = handoffState;
    if (!state) return;

    settingsService.set('app.planMode', false);
    applyRuntimeSetting('app.planMode', false);
    addSystemMessage('Plan mode disabled - switched to Standard mode');

    setHandoffState(null);
    setInput('');
    const handoffMsg = state.handoffMessage || 'Implement this';
    if (state.capturedText) {
      await sendUserMessage({ text: `${handoffMsg}:\n\n${state.capturedText}` });
    }
  }, [handoffState, settingsService, applyRuntimeSetting, addSystemMessage, sendUserMessage, setInput]);

  const declineStandardMode = useCallback(async () => {
    const state = handoffState;
    if (!state) return;

    setHandoffState(null);
    setInput('');
    const handoffMsg = state.handoffMessage || 'Implement this';
    if (state.capturedText) {
      await sendUserMessage({ text: `${handoffMsg}:\n\n${state.capturedText}` });
    }
  }, [handoffState, sendUserMessage, setInput]);

  const submitHandoffInput = useCallback(
    async (turn: UserTurn): Promise<boolean> => {
      const state = handoffState;
      if (!state) return false;

      if (state.stage === 'entering_message') {
        const handoffMessage = turn.text.trim() || 'Implement this';
        setHandoffState({
          ...state,
          handoffMessage,
          stage: 'confirm_model',
        });
        setInput('');
        return true;
      }

      if (state.stage === 'selecting_model') {
        return sendSelectedModelHandoff(state, turn);
      }

      return false;
    },
    [handoffState, sendSelectedModelHandoff, setInput],
  );

  return {
    handoffState,
    startHandoff,
    confirmHandoff,
    declineHandoff,
    cancelHandoff,
    submitHandoffInput,
    confirmStandardMode,
    declineStandardMode,
  };
};
