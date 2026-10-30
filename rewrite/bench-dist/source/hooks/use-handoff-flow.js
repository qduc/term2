import { useCallback, useEffect, useRef, useState } from 'react';
import { HandoffSession } from '../services/handoff/handoff-session.js';
const MODEL_TRIGGER = '/model ';
const EFFORT_TRIGGER = '/effort ';
export const useHandoffFlow = (deps) => {
    const { clearConversationAndRefreshBanner, addSystemMessage, sendUserMessage, replaceInput, controller, settingsService, applyRuntimeSetting, setModelSelection, queueModeNotice, configurationService, } = deps;
    const handoffSessionRef = useRef(null);
    if (!handoffSessionRef.current) {
        handoffSessionRef.current = new HandoffSession({
            clearConversationAndRefreshBanner,
            addSystemMessage,
            sendUserMessage,
            settingsService,
            applyRuntimeSetting,
            setModelSelection,
            queueModeNotice,
            configurationService,
        });
    }
    const handoffSession = handoffSessionRef.current;
    handoffSession.updateDeps({
        clearConversationAndRefreshBanner,
        addSystemMessage,
        sendUserMessage,
        settingsService,
        applyRuntimeSetting,
        setModelSelection,
        queueModeNotice,
        configurationService,
    });
    const [handoffState, setHandoffState] = useState(() => handoffSession.getState());
    useEffect(() => handoffSession.subscribe(setHandoffState), [handoffSession]);
    const handoffStateRef = useRef(handoffState);
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
    const completeHandoffWithEffort = useCallback(async (effort) => {
        if (await handoffSession.completeHandoffWithEffort(effort))
            replaceInput('');
    }, [handoffSession, replaceInput]);
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
            if (!hadModelFrame || hasModelFrame)
                return;
            queueMicrotask(() => {
                if (modelSelectionHandledRef.current) {
                    modelSelectionHandledRef.current = false;
                    return;
                }
                const state = handoffStateRef.current;
                if (state?.stage !== 'selecting_model')
                    return;
                void handoffSession.sendCapturedHandoff().then((handled) => {
                    if (handled)
                        replaceInput('');
                });
            });
        });
    }, [controller, handoffSession, replaceInput]);
    const startHandoff = useCallback((capturedText) => {
        handoffSession.startHandoff(capturedText);
    }, [handoffSession]);
    const confirmHandoff = useCallback(async () => {
        if (!(await handoffSession.confirmHandoff()))
            return;
        modelSelectionHandledRef.current = false;
        controller.replaceText(MODEL_TRIGGER, MODEL_TRIGGER.length);
    }, [handoffSession, controller]);
    const declineHandoff = useCallback(async () => {
        if (await handoffSession.declineHandoff())
            replaceInput('');
    }, [handoffSession, replaceInput]);
    const cancelHandoff = useCallback(() => {
        if (handoffSession.cancelHandoff())
            replaceInput('');
    }, [handoffSession, replaceInput]);
    const confirmStandardMode = useCallback(async () => {
        if (await handoffSession.confirmStandardMode())
            replaceInput('');
    }, [handoffSession, replaceInput]);
    const declineStandardMode = useCallback(async () => {
        if (await handoffSession.declineStandardMode())
            replaceInput('');
    }, [handoffSession, replaceInput]);
    const submitHandoffInput = useCallback(async (turn) => {
        const state = handoffState;
        if (!state)
            return false;
        if (state.stage === 'entering_message') {
            if (handoffSession.captureMessage(turn.text)) {
                replaceInput('');
                return true;
            }
        }
        // Model selection no longer reaches here: the direct `/model ` trigger
        // is controller-owned, so an accepted selection closes through a
        // correlated submit-prompt intent (see `handleModelSubmitPrompt`)
        // rather than a turn routed through the app's `handleSubmit`.
        return false;
    }, [handoffState, handoffSession, replaceInput]);
    const handleModelSubmitPrompt = useCallback((text) => {
        const state = handoffState;
        if (!state || state.stage !== 'selecting_model')
            return false;
        handoffSession.selectModel(text);
        modelSelectionHandledRef.current = true;
        controller.replaceText(EFFORT_TRIGGER, EFFORT_TRIGGER.length);
        return true;
    }, [handoffState, handoffSession, controller]);
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
//# sourceMappingURL=use-handoff-flow.js.map