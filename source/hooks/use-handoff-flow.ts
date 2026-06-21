import { useCallback, useEffect, useReducer, useRef } from 'react';
import { parseInput } from '../utils/input-parser.js';
import { parseModelProviderArg } from '../utils/ai/model-provider-arg.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import type { UserTurn } from '../types/user-turn.js';
import type { InputMode } from '../context/InputContext.js';
import {
  handoffFlowReducer,
  createInitialHandoffState,
  composeHandoffMessage,
  type HandoffStage,
  type HandoffState,
} from './handoff-flow-reducer.js';

export type { HandoffStage, HandoffState };

export type UseHandoffFlowOptions = {
  clearConversationAndRefreshBanner: () => Promise<void>;
  addSystemMessage: (text: string) => void;
  sendUserMessage: (turn: UserTurn) => Promise<void>;
  setInput: (value: string) => void;
  setInputAndCursor: (value: string, cursorOffset: number, cursorOverride?: number | null) => void;
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
  completeHandoffWithEffort: (effort: string) => Promise<void>;
};

const MODEL_TRIGGER = '/model ';

export const useHandoffFlow = (deps: UseHandoffFlowOptions): UseHandoffFlowReturn => {
  const {
    clearConversationAndRefreshBanner,
    addSystemMessage,
    sendUserMessage,
    setInput,
    setInputAndCursor,
    setMode,
    setTriggerIndex,
    mode,
    settingsService,
    applyRuntimeSetting,
    setModel,
  } = deps;

  const [handoffState, dispatch] = useReducer(handoffFlowReducer, null, createInitialHandoffState);

  // Previous render's mode/handoffState, used by the auto-send effect to
  // distinguish a genuine user abandonment of model/effort selection (only
  // `mode` returns to 'text') from a programmatic transition driven by
  // `submitHandoffInput` (which changes `handoffState` in the same batch).
  const prevRef = useRef<{ mode: string; handoffState: HandoffState | null }>({ mode, handoffState });

  const sendCapturedHandoff = useCallback(
    async (state: HandoffState): Promise<boolean> => {
      if (state.stage !== 'selecting_model' && state.stage !== 'selecting_effort') return false;
      const isPlanMode = settingsService.get<boolean>('app.planMode') || false;
      if (isPlanMode) {
        dispatch({ type: 'handoff/standard_mode_requested' });
        setInput('');
        return true;
      }
      dispatch({ type: 'handoff/sent' });
      setInput('');
      await sendUserMessage({ text: composeHandoffMessage(state) });
      return true;
    },
    [settingsService, sendUserMessage, setInput],
  );

  const completeHandoffWithEffort = useCallback(
    async (effort: string) => {
      const state = handoffState;
      if (!state) return;
      settingsService.set('agent.reasoningEffort', effort);
      applyRuntimeSetting('agent.reasoningEffort', effort);
      await sendCapturedHandoff(state);
    },
    [handoffState, settingsService, applyRuntimeSetting, sendCapturedHandoff],
  );

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { mode, handoffState };
    if (mode !== 'text') return;
    if (handoffState === null) return;
    if (handoffState.stage !== 'selecting_model' && handoffState.stage !== 'selecting_effort') return;
    // Only act on a real return-to-text from a non-text mode. This guards
    // against callback-identity re-runs and post-send re-runs.
    if (prev.mode === 'text') return;
    // A programmatic transition (submitHandoffInput) changes handoffState in
    // the same render batch; a true abandonment leaves it unchanged.
    if (prev.handoffState !== handoffState) return;
    void sendCapturedHandoff(handoffState);
  }, [handoffState, mode, sendCapturedHandoff]);

  const startHandoff = useCallback((capturedText: string) => {
    dispatch({ type: 'handoff/started', capturedText });
  }, []);

  const confirmHandoff = useCallback(async () => {
    if (!handoffState) return;

    await clearConversationAndRefreshBanner();
    dispatch({ type: 'handoff/model_confirmed' });
    setInputAndCursor(MODEL_TRIGGER, MODEL_TRIGGER.length, MODEL_TRIGGER.length);
    setMode('model_selection');
    setTriggerIndex(MODEL_TRIGGER.length);
  }, [clearConversationAndRefreshBanner, handoffState, setInputAndCursor, setMode, setTriggerIndex]);

  const declineHandoff = useCallback(async () => {
    const state = handoffState;
    if (!state) return;

    const isPlanMode = settingsService.get<boolean>('app.planMode') || false;
    if (isPlanMode) {
      await clearConversationAndRefreshBanner();
      dispatch({ type: 'handoff/standard_mode_requested' });
      setInput('');
      return;
    }

    await clearConversationAndRefreshBanner();
    dispatch({ type: 'handoff/sent' });
    setInput('');
    if (state.capturedText) {
      await sendUserMessage({ text: composeHandoffMessage(state) });
    }
  }, [clearConversationAndRefreshBanner, handoffState, sendUserMessage, setInput, settingsService]);

  const cancelHandoff = useCallback(() => {
    dispatch({ type: 'handoff/cancelled' });
    setInput('');
    addSystemMessage('Handoff cancelled');
  }, [addSystemMessage, setInput]);

  const confirmStandardMode = useCallback(async () => {
    const state = handoffState;
    if (!state) return;

    settingsService.set('app.planMode', false);
    applyRuntimeSetting('app.planMode', false);
    addSystemMessage('Plan mode disabled - switched to Standard mode');

    dispatch({ type: 'handoff/sent' });
    setInput('');
    if (state.capturedText) {
      await sendUserMessage({ text: composeHandoffMessage(state) });
    }
  }, [handoffState, settingsService, applyRuntimeSetting, addSystemMessage, sendUserMessage, setInput]);

  const declineStandardMode = useCallback(async () => {
    const state = handoffState;
    if (!state) return;

    dispatch({ type: 'handoff/sent' });
    setInput('');
    if (state.capturedText) {
      await sendUserMessage({ text: composeHandoffMessage(state) });
    }
  }, [handoffState, sendUserMessage, setInput]);

  const submitHandoffInput = useCallback(
    async (turn: UserTurn): Promise<boolean> => {
      const state = handoffState;
      if (!state) return false;

      if (state.stage === 'entering_message') {
        const handoffMessage = turn.text.trim() || 'Implement this';
        dispatch({ type: 'handoff/message_captured', handoffMessage });
        setInput('');
        return true;
      }

      if (state.stage === 'selecting_model') {
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

        dispatch({ type: 'handoff/model_selected' });
        setInputAndCursor('/effort ', '/effort '.length, '/effort '.length);
        setMode('text');
        setTriggerIndex(null);
        return true;
      }

      return false;
    },
    [
      applyRuntimeSetting,
      handoffState,
      setInput,
      setInputAndCursor,
      setMode,
      setModel,
      setTriggerIndex,
      settingsService,
    ],
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
    completeHandoffWithEffort,
  };
};
