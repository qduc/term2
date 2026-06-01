import { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import type { InputMode } from '../context/InputContext.js';
import type { MutableRefObject } from 'react';
import { SETTINGS_TRIGGER } from '../components/Input/triggers.js';

export type CompletionDismissal = {
  type: 'path' | 'settings_value';
  inputRevision: number;
} | null;

const ESC_HINT_TIMEOUT_MS = 2000;

type SettingsHandle = {
  open: (startIndex: number, initialSelectionKey?: string) => void;
};

type SettingsValueHandle = {
  settingKey: string | null;
  close: () => void;
};

type ModelsHandle = {
  modelSettingConfig?: { modelKey: string } | null;
  close: () => void;
};

type Options = {
  mode: InputMode;
  setMode: (mode: InputMode) => void;
  value: string;
  onChange: (value: string) => void;
  settings: SettingsHandle;
  settingsValue: SettingsValueHandle;
  models?: ModelsHandle;
  setCursorOverride: (cursor: number | null) => void;
  dismissedCompletionRef: MutableRefObject<CompletionDismissal>;
  inputRevisionRef: MutableRefObject<number>;
};

export const useEscapeKey = ({
  mode,
  setMode,
  value,
  onChange,
  settings,
  settingsValue,
  models,
  setCursorOverride,
  dismissedCompletionRef,
  inputRevisionRef,
}: Options): { escHintVisible: boolean } => {
  const [escHintVisible, setEscHintVisible] = useState(false);
  const escTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stateRef = useRef({ mode, escHintVisible, value, settingsValue, models });
  stateRef.current = { mode, escHintVisible, value, settingsValue, models };

  useEffect(() => {
    return () => {
      if (escTimeoutRef.current) clearTimeout(escTimeoutRef.current);
    };
  }, []);

  useInput((_input, key) => {
    if (!key.escape) return;

    const {
      mode: currentMode,
      escHintVisible: currentEscHintVisible,
      value: currentValue,
      settingsValue: currentSettingsValue,
      models: currentModels,
    } = stateRef.current;

    if (currentMode !== 'text') {
      if (currentMode === 'model_selection') {
        // Check if this is a settings-backed model selection (e.g. from /settings)
        if (currentModels?.modelSettingConfig && currentValue.startsWith(SETTINGS_TRIGGER)) {
          const prefix = SETTINGS_TRIGGER;
          onChange(prefix);
          setCursorOverride(prefix.length);

          const previousKey = currentModels.modelSettingConfig.modelKey;
          currentModels.close();
          settings.open(prefix.length, previousKey);
          return;
        }

        // Non-settings-backed: clear input and exit to text mode
        onChange('');
        setMode('text');
        return;
      }

      if (currentMode === 'settings_value_completion' && currentSettingsValue.settingKey) {
        if (currentValue.startsWith(SETTINGS_TRIGGER)) {
          const prefix = SETTINGS_TRIGGER;
          onChange(prefix);
          setCursorOverride(prefix.length);

          const previousKey = currentSettingsValue.settingKey;
          currentSettingsValue.close();
          settings.open(prefix.length, previousKey);
          return;
        }
      }

      if (currentMode === 'slash_commands' || currentMode === 'settings_completion') {
        onChange('');
        setMode('text');
        return;
      }

      if (currentMode === 'path_completion' || currentMode === 'settings_value_completion') {
        // Cancelling an inline completion popup must not destroy the buffer.
        // The trigger character/text the user typed stays in place; only the
        // popup closes. dismissedCompletionRef records this dismissal for the
        // current inputRevision so unrelated re-renders (e.g. async refresh
        // completing) cannot re-open the popup. The dismissal is cleared when
        // the user edits the value or moves the cursor.
        dismissedCompletionRef.current = {
          type: currentMode === 'path_completion' ? 'path' : 'settings_value',
          inputRevision: inputRevisionRef.current,
        };
        setMode('text');
        return;
      }

      setMode('text');
      return;
    }

    // Text mode: double ESC clears.
    if (currentEscHintVisible) {
      if (escTimeoutRef.current) {
        clearTimeout(escTimeoutRef.current);
        escTimeoutRef.current = null;
      }
      setEscHintVisible(false);
      onChange('');
      return;
    }

    setEscHintVisible(true);
    escTimeoutRef.current = setTimeout(() => {
      setEscHintVisible(false);
      escTimeoutRef.current = null;
    }, ESC_HINT_TIMEOUT_MS);
  });

  return { escHintVisible };
};
