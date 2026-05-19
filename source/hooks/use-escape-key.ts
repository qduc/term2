import { MutableRefObject, useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import type { InputMode } from '../context/InputContext.js';
import { SETTINGS_TRIGGER } from '../components/Input/triggers.js';

const ESC_HINT_TIMEOUT_MS = 2000;

type SettingsHandle = {
  open: (startIndex: number, initialSelectionKey?: string) => void;
};

type SettingsValueHandle = {
  settingKey: string | null;
  close: () => void;
};

type Options = {
  mode: InputMode;
  setMode: (mode: InputMode) => void;
  value: string;
  onChange: (value: string) => void;
  settings: SettingsHandle;
  settingsValue: SettingsValueHandle;
  setCursorOverride: (cursor: number | null) => void;
  escPressedRef: MutableRefObject<boolean>;
};

export const useEscapeKey = ({
  mode,
  setMode,
  value,
  onChange,
  settings,
  settingsValue,
  setCursorOverride,
  escPressedRef,
}: Options): { escHintVisible: boolean } => {
  const [escHintVisible, setEscHintVisible] = useState(false);
  const escTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stateRef = useRef({ mode, escHintVisible, value, settingsValue });
  stateRef.current = { mode, escHintVisible, value, settingsValue };

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
    } = stateRef.current;

    escPressedRef.current = true;

    if (currentMode !== 'text') {
      if (currentMode === 'model_selection') {
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

      if (
        currentMode === 'slash_commands' ||
        currentMode === 'path_completion' ||
        currentMode === 'settings_completion' ||
        currentMode === 'settings_value_completion'
      ) {
        onChange('');
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
