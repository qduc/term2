import React, { createContext, useContext, useMemo, useState, useCallback, useRef, useSyncExternalStore, ReactNode } from 'react';
import type { ImageRef } from 'ink-prompt';
import { MenuControllerImpl } from '../components/input/menu-controller.js';
import type { MenuController, MenuFrame } from '../components/input/menu-types.js';

export type InputMode =
  | 'text'
  | 'slash_commands'
  | 'path_completion'
  | 'settings_completion'
  | 'settings_value_completion'
  | 'model_selection'
  | 'skill_selection'
  | 'rewind_selection'
  | 'provider_selection';

export function frameKindToLegacyMode(kind: MenuFrame['kind'] | undefined): InputMode {
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
    case 'rewind':
      return 'rewind_selection';
    case 'providers':
      return 'provider_selection';
    default:
      return 'text';
  }
}

interface InputState {
  input: string;
  mode: InputMode;
  cursorOffset: number;
  triggerIndex: number | null;
  images: ImageRef[];
  cursorOverride: number | null;
  controller: MenuController;
}

interface InputActions {
  setInput: (value: string) => void;
  replaceInput: (value: string) => void;
  setMode: (mode: InputMode) => void;
  setCursorOffset: (offset: number) => void;
  setTriggerIndex: (index: number | null) => void;
  setImages: React.Dispatch<React.SetStateAction<ImageRef[]>>;
  setInputAndCursor: (value: string, cursorOffset: number, cursorOverride?: number | null) => void;
  setCursorOverride: (offset: number | null) => void;
}

const InputStateContext = createContext<InputState | undefined>(undefined);
const InputActionsContext = createContext<InputActions | undefined>(undefined);

export const InputProvider = ({
  children,
  controller: providedController,
}: {
  children: ReactNode;
  controller?: MenuController;
}) => {
  const [controller] = useState(() => providedController ?? new MenuControllerImpl());
  const snapshot = useSyncExternalStore(
    controller.subscribe.bind(controller),
    controller.getSnapshot.bind(controller),
  );

  const [legacyMode, setLegacyMode] = useState<InputMode>('text');
  const legacyCursorOffsetRef = useRef(0);
  const [triggerIndex, setTriggerIndex] = useState<number | null>(null);
  const [images, setImages] = useState<ImageRef[]>([]);
  const [cursorOverride, setCursorOverride] = useState<number | null>(null);

  const mode = snapshot.stack.length > 0
    ? frameKindToLegacyMode(snapshot.stack.at(-1)?.kind)
    : legacyMode;

  const cursorOffset = snapshot.editor.text.length > 0
    ? snapshot.editor.cursor
    : legacyCursorOffsetRef.current;

  const setInput = useCallback(
    (value: string) => {
      controller.replaceText(value);
    },
    [controller],
  );

  const setCursorOffset = useCallback(
    (offset: number) => {
      legacyCursorOffsetRef.current = offset;
      controller.applyEditorEdit({ type: 'move-cursor', cursor: offset });
    },
    [controller],
  );

  const setInputAndCursor = useCallback(
    (value: string, offset: number, override: number | null = null) => {
      legacyCursorOffsetRef.current = offset;
      controller.replaceText(value, offset);
      setCursorOverride(override);
    },
    [controller],
  );

  const replaceInput = useCallback(
    (value: string) => {
      controller.replaceText(value);
    },
    [controller],
  );

  const setMode = useCallback(
    (newMode: InputMode) => {
      setLegacyMode(newMode);
      if (newMode === 'text') {
        controller.closeAll();
      }
    },
    [controller],
  );

  const state = useMemo<InputState>(
    () => ({
      input: snapshot.editor.text,
      mode,
      cursorOffset,
      triggerIndex,
      images,
      cursorOverride,
      controller,
    }),
    [snapshot.editor.text, mode, cursorOffset, triggerIndex, images, cursorOverride, controller],
  );

  const actions = useMemo<InputActions>(
    () => ({
      setInput,
      replaceInput,
      setMode,
      setCursorOffset,
      setTriggerIndex,
      setImages,
      setInputAndCursor,
      setCursorOverride,
    }),
    [setInput, replaceInput, setMode, setCursorOffset, setInputAndCursor],
  );

  return (
    <InputStateContext.Provider value={state}>
      <InputActionsContext.Provider value={actions}>{children}</InputActionsContext.Provider>
    </InputStateContext.Provider>
  );
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
