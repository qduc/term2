import React, {
  createContext,
  useContext,
  useMemo,
  useState,
  useCallback,
  useSyncExternalStore,
  ReactNode,
} from 'react';
import type { ImageRef } from 'ink-prompt';
import { MenuControllerImpl } from '../components/input/menu-controller.js';
import { createDefaultTriggerRegistry } from '../components/input/triggers.js';
import type { MenuController, MenuFrame, MenuInteractionRegistry } from '../components/input/menu-types.js';
import type { SlashCommand } from '../slash-commands.js';

const DEFAULT_MENU_COMMANDS: SlashCommand[] = [
  {
    name: '/model',
    description: 'Select a model',
    action: () => {},
    completion: { type: 'model', trigger: '/model ' },
  },
  {
    name: '/settings',
    description: 'Open settings',
    action: () => {},
    completion: { type: 'settings', trigger: '/settings ', resetTrigger: '/settings reset ' },
  },
  {
    name: '/skills',
    description: 'Select a skill',
    action: () => {},
    completion: { type: 'skills', trigger: '/skills ' },
  },
];

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
  interactions: MenuInteractionRegistry;
  menuPromptLabel: string | undefined;
}

interface InputActions {
  setInput: (value: string) => void;
  replaceInput: (value: string) => void;
  setCursorOffset: (offset: number) => void;
  setImages: React.Dispatch<React.SetStateAction<ImageRef[]>>;
  setInputAndCursor: (value: string, cursorOffset: number, cursorOverride?: number | null) => void;
  setCursorOverride: (offset: number | null) => void;
  setMenuPromptLabel: (label: string | undefined) => void;
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
  const [controller] = useState(
    () =>
      providedController ??
      new MenuControllerImpl({ triggerRegistry: createDefaultTriggerRegistry(DEFAULT_MENU_COMMANDS) }),
  );
  const interactions = controller.getInteractionRegistry();
  const snapshot = useSyncExternalStore(controller.subscribe.bind(controller), controller.getSnapshot.bind(controller));

  const [images, setImages] = useState<ImageRef[]>([]);
  const [cursorOverride, setCursorOverride] = useState<number | null>(null);
  const [menuPromptLabel, setMenuPromptLabel] = useState<string | undefined>(undefined);

  const activeFrame = snapshot.stack.at(-1);
  const mode = frameKindToLegacyMode(activeFrame?.kind);
  const triggerIndex = activeFrame && 'binding' in activeFrame ? activeFrame.binding.replacement.start : null;

  const cursorOffset = snapshot.editor.cursor;

  const setInput = useCallback(
    (value: string) => {
      controller.replaceText(value);
    },
    [controller],
  );

  const setCursorOffset = useCallback(
    (offset: number) => {
      controller.applyEditorEdit({ type: 'move-cursor', cursor: offset });
    },
    [controller],
  );

  const setInputAndCursor = useCallback(
    (value: string, offset: number, override: number | null = null) => {
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

  const state = useMemo<InputState>(
    () => ({
      input: snapshot.editor.text,
      mode,
      cursorOffset,
      triggerIndex,
      images,
      cursorOverride,
      controller,
      interactions,
      menuPromptLabel,
    }),
    [
      snapshot.editor.text,
      mode,
      cursorOffset,
      triggerIndex,
      images,
      cursorOverride,
      controller,
      interactions,
      menuPromptLabel,
    ],
  );

  const actions = useMemo<InputActions>(
    () => ({
      setInput,
      replaceInput,
      setCursorOffset,
      setImages,
      setInputAndCursor,
      setCursorOverride,
      setMenuPromptLabel,
    }),
    [setInput, replaceInput, setCursorOffset, setInputAndCursor, setMenuPromptLabel],
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
