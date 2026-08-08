import { useCallback, useEffect, useReducer, useRef } from 'react';
import { parseInput } from '../utils/input-parser.js';
import { parseModelProviderArg } from '../utils/ai/model-provider-arg.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import type { UserTurn } from '../types/user-turn.js';
import type { MenuController } from '../components/input/menu-types.js';
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
  replaceInput: (value: string) => void;
  controller: MenuController;
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
  // Consumed by the application effect host's `submit-prompt` intent handler
  // (app.tsx). The direct `/model ` trigger's accept path now closes through
  // a correlated `submit-prompt` intent rather than a turn routed through
  // `handleSubmit`, so this is the only place a captured model selection can
  // still be intercepted before it would otherwise be sent to the model as a
  // literal chat message. Returns true when the intent belonged to an
  // in-flight handoff and has been fully handled (settings applied, input
  // advanced to `/effort `); false when the caller should fall back to its
  // normal submit-prompt handling.
  handleModelSubmitPrompt: (text: string) => boolean;
};

const MODEL_TRIGGER = '/model ';
const EFFORT_TRIGGER = '/effort ';

export const useHandoffFlow = (deps: UseHandoffFlowOptions): UseHandoffFlowReturn => {
  const {
    clearConversationAndRefreshBanner,
    addSystemMessage,
    sendUserMessage,
    replaceInput,
    controller,
    settingsService,
    applyRuntimeSetting,
    setModel,
  } = deps;

  const [handoffState, dispatch] = useReducer(handoffFlowReducer, null, createInitialHandoffState);
  const handoffStateRef = useRef<HandoffState | null>(handoffState);
  handoffStateRef.current = handoffState;

  // Tracks whether the model frame is currently on the controller's stack, so
  // the subscription below can detect the true->false "just closed"
  // transition rather than reacting to every stack change (typing while the
  // menu stays open, opening a different frame, ...).
  const hadModelFrameRef = useRef(false);
  // Set synchronously by `handleModelSubmitPrompt` when it consumes a
  // submit-prompt intent for the model this handoff opened. Read by the
  // "closed" detector below to distinguish an accepted selection from an
  // escape that closed the picker with nothing chosen.
  const modelSelectionHandledRef = useRef(false);

  const sendCapturedHandoff = useCallback(
    async (state: HandoffState): Promise<boolean> => {
      if (state.stage !== 'selecting_model' && state.stage !== 'selecting_effort') return false;
      const isPlanMode = settingsService.get('app.planMode') || false;
      if (isPlanMode) {
        dispatch({ type: 'handoff/standard_mode_requested' });
        replaceInput('');
        return true;
      }
      dispatch({ type: 'handoff/sent' });
      replaceInput('');
      await sendUserMessage({ text: composeHandoffMessage(state) });
      return true;
    },
    [settingsService, sendUserMessage, replaceInput],
  );

  const completeHandoffWithEffort = useCallback(
    async (effort: string) => {
      const state = handoffState;
      if (!state) return;
      settingsService.set('agent.reasoningEffort', effort as any);
      applyRuntimeSetting('agent.reasoningEffort', effort);
      await sendCapturedHandoff(state);
    },
    [handoffState, settingsService, applyRuntimeSetting, sendCapturedHandoff],
  );

  // Replaces the `mode` projection this used to watch (mode returning to
  // 'text' while still in the 'selecting_model' stage meant "the picker
  // closed without an explicit accept"). The controller's stack is the
  // source of truth now: a 'model' frame leaving the stack is the same
  // event, and it fires for both an accepted selection (closed via the
  // submit-prompt intent below) and an escape (closed with no intent).
  //
  // The two cases are not distinguishable at the moment this subscriber
  // runs: `MenuControllerImpl.dispatch` calls `notify()` (which reaches this
  // subscriber) *before* it invokes the intent host, so an accepted
  // selection's `handleModelSubmitPrompt` call has not happened yet. The
  // `queueMicrotask` defers the decision until the rest of that synchronous
  // dispatch — including a synchronous `handleModelSubmitPrompt` call — has
  // run, so `modelSelectionHandledRef` is settled before it is read. This
  // does not depend on React's render/batching timing at all, only on plain
  // JS microtask ordering within the same call stack.
  useEffect(() => {
    return controller.subscribe(() => {
      const hasModelFrame = controller.getSnapshot().stack.some((frame) => frame.kind === 'model');
      const hadModelFrame = hadModelFrameRef.current;
      hadModelFrameRef.current = hasModelFrame;
      if (!hadModelFrame || hasModelFrame) return;

      queueMicrotask(() => {
        if (modelSelectionHandledRef.current) {
          modelSelectionHandledRef.current = false;
          return;
        }
        const state = handoffStateRef.current;
        if (state?.stage !== 'selecting_model') return;
        void sendCapturedHandoff(state);
      });
    });
  }, [controller, sendCapturedHandoff]);

  const startHandoff = useCallback((capturedText: string) => {
    dispatch({ type: 'handoff/started', capturedText });
  }, []);

  const confirmHandoff = useCallback(async () => {
    if (!handoffState) return;

    await clearConversationAndRefreshBanner();
    dispatch({ type: 'handoff/model_confirmed' });
    modelSelectionHandledRef.current = false;
    controller.replaceText(MODEL_TRIGGER, MODEL_TRIGGER.length);
  }, [clearConversationAndRefreshBanner, handoffState, controller]);

  const declineHandoff = useCallback(async () => {
    const state = handoffState;
    if (!state) return;

    const isPlanMode = settingsService.get('app.planMode') || false;
    if (isPlanMode) {
      await clearConversationAndRefreshBanner();
      dispatch({ type: 'handoff/standard_mode_requested' });
      replaceInput('');
      return;
    }

    await clearConversationAndRefreshBanner();
    dispatch({ type: 'handoff/sent' });
    replaceInput('');
    if (state.capturedText) {
      await sendUserMessage({ text: composeHandoffMessage(state) });
    }
  }, [clearConversationAndRefreshBanner, handoffState, sendUserMessage, replaceInput, settingsService]);

  const cancelHandoff = useCallback(() => {
    dispatch({ type: 'handoff/cancelled' });
    replaceInput('');
    addSystemMessage('Handoff cancelled');
  }, [addSystemMessage, replaceInput]);

  const confirmStandardMode = useCallback(async () => {
    const state = handoffState;
    if (!state) return;

    settingsService.set('app.planMode', false);
    applyRuntimeSetting('app.planMode', false);
    addSystemMessage('Plan mode disabled - switched to Standard mode');

    dispatch({ type: 'handoff/sent' });
    replaceInput('');
    if (state.capturedText) {
      await sendUserMessage({ text: composeHandoffMessage(state) });
    }
  }, [handoffState, settingsService, applyRuntimeSetting, addSystemMessage, sendUserMessage, replaceInput]);

  const declineStandardMode = useCallback(async () => {
    const state = handoffState;
    if (!state) return;

    dispatch({ type: 'handoff/sent' });
    replaceInput('');
    if (state.capturedText) {
      await sendUserMessage({ text: composeHandoffMessage(state) });
    }
  }, [handoffState, sendUserMessage, replaceInput]);

  const submitHandoffInput = useCallback(
    async (turn: UserTurn): Promise<boolean> => {
      const state = handoffState;
      if (!state) return false;

      if (state.stage === 'entering_message') {
        const handoffMessage = turn.text.trim() || 'Implement this';
        dispatch({ type: 'handoff/message_captured', handoffMessage });
        replaceInput('');
        return true;
      }

      // Model selection no longer reaches here: the direct `/model ` trigger
      // is controller-owned, so an accepted selection closes through a
      // correlated submit-prompt intent (see `handleModelSubmitPrompt`)
      // rather than a turn routed through the app's `handleSubmit`.
      return false;
    },
    [handoffState, replaceInput],
  );

  const handleModelSubmitPrompt = useCallback(
    (text: string): boolean => {
      const state = handoffState;
      if (!state || state.stage !== 'selecting_model') return false;

      const parsedInput = parseInput(text);
      const modelArg = parsedInput.type === 'slash-command' ? parsedInput.args : text;
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

      modelSelectionHandledRef.current = true;
      dispatch({ type: 'handoff/model_selected' });
      controller.replaceText(EFFORT_TRIGGER, EFFORT_TRIGGER.length);
      return true;
    },
    [handoffState, settingsService, applyRuntimeSetting, setModel, controller],
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
    handleModelSubmitPrompt,
  };
};
