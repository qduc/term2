import React, { createContext, useContext, useMemo, useState, ReactNode } from 'react';

export type InputMode =
  | 'text'
  | 'slash_commands'
  | 'path_completion'
  | 'settings_completion'
  | 'settings_value_completion'
  | 'model_selection';

interface InputState {
  input: string;
  mode: InputMode;
  cursorOffset: number;
  triggerIndex: number | null;
}

interface InputActions {
  setInput: (value: string) => void;
  setMode: (mode: InputMode) => void;
  setCursorOffset: (offset: number) => void;
  setTriggerIndex: (index: number | null) => void;
}

const InputStateContext = createContext<InputState | undefined>(undefined);
const InputActionsContext = createContext<InputActions | undefined>(undefined);

export const InputProvider = ({ children }: { children: ReactNode }) => {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<InputMode>('text');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [triggerIndex, setTriggerIndex] = useState<number | null>(null);

  const state = useMemo<InputState>(
    () => ({ input, mode, cursorOffset, triggerIndex }),
    [input, mode, cursorOffset, triggerIndex],
  );

  const actions = useMemo<InputActions>(() => ({ setInput, setMode, setCursorOffset, setTriggerIndex }), []);

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
