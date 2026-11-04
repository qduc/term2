/**
 * The menu half of source/context/InputContext.tsx. Legacy menu hooks read the
 * controller-owned editor through `useInputContext()`; this keeps that contract
 * so the hooks copy unchanged. Queue/image composer state stays with the native
 * session composer, which mirrors its draft into the controller.
 */
import React, {
  createContext,
  useContext,
  useMemo,
  useState,
  useCallback,
  useSyncExternalStore,
  ReactNode,
} from 'react';
import type { MenuController, MenuFrame, MenuInteractionRegistry, MenuState } from './menu-types.js';
import type { TuiMenus } from '../integration.js';

export type InputMode =
  | 'text'
  | 'slash_commands'
  | 'path_completion'
  | 'settings_completion'
  | 'settings_value_completion'
  | 'model_selection'
  | 'skill_selection'
  | 'profile_selection'
  | 'resume_selection'
  | 'copy_selection'
  | 'rewind_selection'
  | 'provider_selection'
  | 'subagent_pool_selection';

function frameKindToLegacyMode(kind: MenuFrame['kind'] | undefined): InputMode {
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

interface InputState {
  input: string;
  stack: MenuState['stack'];
  mode: InputMode;
  cursorOffset: number;
  triggerIndex: number | null;
  cursorOverride: number | null;
  controller: MenuController;
  interactions: MenuInteractionRegistry;
  menuPromptLabel: string | undefined;
  menus: TuiMenus;
  sessionId: string;
}

interface InputActions {
  setInput: (value: string) => void;
  /** Legacy's external replacement; next keeps no composer queue state, so it only replaces the text. */
  replaceInput: (value: string) => void;
  setCursorOffset: (offset: number) => void;
  setInputAndCursor: (value: string, cursorOffset: number, cursorOverride?: number | null) => void;
  setCursorOverride: (offset: number | null) => void;
  setMenuPromptLabel: (label: string | undefined) => void;
}

const InputStateContext = createContext<InputState | undefined>(undefined);
const InputActionsContext = createContext<InputActions | undefined>(undefined);

export const InputProvider = ({
  children,
  controller,
  menus,
  sessionId,
}: {
  children: ReactNode;
  controller: MenuController;
  menus: TuiMenus;
  sessionId: string;
}) => {
  const interactions = controller.getInteractionRegistry();
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [cursorOverride, setCursorOverride] = useState<number | null>(null);
  const [menuPromptLabel, setMenuPromptLabel] = useState<string | undefined>(undefined);

  const activeFrame = snapshot.stack.at(-1);
  const mode = frameKindToLegacyMode(activeFrame?.kind);
  const triggerIndex = activeFrame && 'binding' in activeFrame ? activeFrame.binding.replacement.start : null;
  const cursorOffset = snapshot.editor.cursor;

  const setInput = useCallback((value: string) => controller.replaceText(value), [controller]);
  const setCursorOffset = useCallback(
    (offset: number) => controller.applyEditorEdit({ type: 'move-cursor', cursor: offset }),
    [controller],
  );
  const setInputAndCursor = useCallback(
    (value: string, offset: number, override: number | null = null) => {
      controller.replaceText(value, offset);
      setCursorOverride(override);
    },
    [controller],
  );

  const state = useMemo<InputState>(
    () => ({
      input: snapshot.editor.text,
      stack: snapshot.stack,
      mode,
      cursorOffset,
      triggerIndex,
      cursorOverride,
      controller,
      interactions,
      menuPromptLabel,
      menus,
      sessionId,
    }),
    [
      snapshot.editor.text,
      snapshot.stack,
      mode,
      cursorOffset,
      triggerIndex,
      cursorOverride,
      controller,
      interactions,
      menuPromptLabel,
      menus,
      sessionId,
    ],
  );
  const actions = useMemo<InputActions>(
    () => ({
      setInput,
      replaceInput: setInput,
      setCursorOffset,
      setInputAndCursor,
      setCursorOverride,
      setMenuPromptLabel,
    }),
    [setInput, setCursorOffset, setInputAndCursor],
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
  if (!state || !actions) throw new Error('useInputContext must be used within an InputProvider');
  return { ...state, ...actions };
};
