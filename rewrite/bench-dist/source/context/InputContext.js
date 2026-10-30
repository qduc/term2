import React, { createContext, useContext, useMemo, useState, useCallback, useSyncExternalStore, } from 'react';
import { MenuControllerImpl } from '../components/input/menu-controller.js';
import { createDefaultTriggerRegistry } from '../components/input/triggers.js';
const DEFAULT_MENU_COMMANDS = [
    {
        name: '/model',
        description: 'Select a model',
        action: () => { },
        completion: { type: 'model', trigger: '/model ' },
    },
    {
        name: '/settings',
        description: 'Open settings',
        action: () => { },
        completion: { type: 'settings', trigger: '/settings ', resetTrigger: '/settings reset ' },
    },
    {
        name: '/skills',
        description: 'Select a skill',
        action: () => { },
        completion: { type: 'skills', trigger: '/skills ' },
    },
    {
        name: '/profile',
        description: 'Select a profile',
        action: () => { },
        completion: { type: 'profile', trigger: '/profile ' },
    },
];
function frameKindToLegacyMode(kind) {
    switch (kind) {
        case 'slash':
            return 'slash_commands';
        case 'path':
            return 'path_completion';
        case 'settings':
            return 'settings_completion';
        case 'settings_value':
            return 'settings_value_completion';
        case 'model':
            return 'model_selection';
        case 'skills':
            return 'skill_selection';
        case 'profile':
            return 'profile_selection';
        case 'resume':
            return 'resume_selection';
        case 'copy':
            return 'copy_selection';
        case 'rewind':
            return 'rewind_selection';
        case 'providers':
            return 'provider_selection';
        case 'subagent_pool':
            return 'subagent_pool_selection';
        default:
            return 'text';
    }
}
const InputStateContext = createContext(undefined);
const InputActionsContext = createContext(undefined);
export const InputProvider = ({ children, controller: providedController, }) => {
    const [controller] = useState(() => providedController ??
        new MenuControllerImpl({ triggerRegistry: createDefaultTriggerRegistry(DEFAULT_MENU_COMMANDS) }));
    const interactions = controller.getInteractionRegistry();
    const subscribe = useCallback((listener) => controller.subscribe(listener), [controller]);
    const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    // Composer interaction state must outlive the editor/menu and modal cutovers.
    const [queueInput, setQueueInput] = useState({ selectionIndex: null, editing: null, notice: null });
    const [inputReplacementRevision, setInputReplacementRevision] = useState(0);
    const [images, setImages] = useState([]);
    const [cursorOverride, setCursorOverride] = useState(null);
    const [menuPromptLabel, setMenuPromptLabel] = useState(undefined);
    const activeFrame = snapshot.stack.at(-1);
    const mode = frameKindToLegacyMode(activeFrame?.kind);
    const triggerIndex = activeFrame && 'binding' in activeFrame ? activeFrame.binding.replacement.start : null;
    const cursorOffset = snapshot.editor.cursor;
    const setInput = useCallback((value) => {
        controller.replaceText(value);
    }, [controller]);
    const setCursorOffset = useCallback((offset) => {
        controller.applyEditorEdit({ type: 'move-cursor', cursor: offset });
    }, [controller]);
    const setInputAndCursor = useCallback((value, offset, override = null) => {
        controller.replaceText(value, offset);
        setCursorOverride(override);
    }, [controller]);
    const replaceInput = useCallback((value) => {
        // External replacement (clear, resume, restored turn, etc.) starts a new
        // composer interaction. Menu edits use the controller directly instead.
        setQueueInput({ selectionIndex: null, editing: null, notice: null });
        setInputReplacementRevision((revision) => revision + 1);
        controller.replaceText(value);
    }, [controller]);
    const state = useMemo(() => ({
        input: snapshot.editor.text,
        stack: snapshot.stack,
        mode,
        cursorOffset,
        triggerIndex,
        images,
        queueInput,
        inputReplacementRevision,
        cursorOverride,
        controller,
        interactions,
        menuPromptLabel,
    }), [
        snapshot.editor.text,
        snapshot.stack,
        mode,
        cursorOffset,
        triggerIndex,
        images,
        queueInput,
        inputReplacementRevision,
        cursorOverride,
        controller,
        interactions,
        menuPromptLabel,
    ]);
    const actions = useMemo(() => ({
        setInput,
        setQueueInput,
        replaceInput,
        setCursorOffset,
        setImages,
        setInputAndCursor,
        setCursorOverride,
        setMenuPromptLabel,
    }), [setInput, replaceInput, setCursorOffset, setInputAndCursor, setMenuPromptLabel]);
    return (React.createElement(InputStateContext.Provider, { value: state },
        React.createElement(InputActionsContext.Provider, { value: actions }, children)));
};
export const useInputContext = () => {
    const state = useContext(InputStateContext);
    const actions = useContext(InputActionsContext);
    if (!state || !actions) {
        throw new Error('useInputContext must be used within an InputProvider');
    }
    return { ...state, ...actions };
};
export const useInputActions = () => {
    const actions = useContext(InputActionsContext);
    if (!actions) {
        throw new Error('useInputActions must be used within an InputProvider');
    }
    return actions;
};
export const useInputState = () => {
    const state = useContext(InputStateContext);
    if (!state) {
        throw new Error('useInputState must be used within an InputProvider');
    }
    return state;
};
//# sourceMappingURL=InputContext.js.map