import { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import type { InputMode } from '../context/InputContext.js';
import type { MutableRefObject } from 'react';
import { SETTINGS_TRIGGER } from '../components/input/triggers.js';

export type CompletionDismissal = {
  type: 'path' | 'settings_value' | 'skill_selection';
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

type ProviderSelectionHandle = {
  goBack: () => void;
};

type Options = {
  mode: InputMode;
  setMode: (mode: InputMode) => void;
  value: string;
  onChange: (value: string) => void;
  settings: SettingsHandle;
  settingsValue: SettingsValueHandle;
  models?: ModelsHandle;
  providerSelection?: ProviderSelectionHandle;
  setCursorOverride: (cursor: number | null) => void;
  dismissedCompletionRef: MutableRefObject<CompletionDismissal>;
  inputRevisionRef: MutableRefObject<number>;
  /** Return true when an InputBox-local surface consumed Escape. */
  onEscape?: () => boolean;
  /**
   * True while a turn is in flight. Clearing the buffer still wins whenever
   * there is text to clear; only on an empty buffer does text-mode Escape defer
   * to the app-level double-Escape interrupt confirmation.
   */
  turnInFlight?: boolean;
};

export const useEscapeKey = ({
  mode,
  setMode,
  value,
  onChange,
  settings,
  settingsValue,
  models,
  providerSelection,
  setCursorOverride,
  dismissedCompletionRef,
  inputRevisionRef,
  onEscape,
  turnInFlight = false,
}: Options): { escHintVisible: boolean } => {
  const [escHintVisible, setEscHintVisible] = useState(false);
  const escTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  const stateRef = useRef({
    mode,
    escHintVisible,
    value,
    settings,
    settingsValue,
    models,
    providerSelection,
    turnInFlight,
  });
  stateRef.current = { mode, escHintVisible, value, settings, settingsValue, models, providerSelection, turnInFlight };

  useEffect(() => {
    return () => {
      if (escTimeoutRef.current) clearTimeout(escTimeoutRef.current);
    };
  }, []);

  // Drop a pending clear-hint once the buffer is empty mid-turn: Escape then
  // belongs to the interrupt confirmation, so a stale hint would promise a
  // clear that will not happen.
  useEffect(() => {
    if (!turnInFlight || value.length > 0) return;
    if (escTimeoutRef.current) {
      clearTimeout(escTimeoutRef.current);
      escTimeoutRef.current = null;
    }
    setEscHintVisible(false);
  }, [turnInFlight, value]);

  useInput((_input, key) => {
    if (!key.escape) return;
    if (onEscapeRef.current?.()) return;

    const {
      mode: currentMode,
      escHintVisible: currentEscHintVisible,
      value: currentValue,
      settings: currentSettings,
      settingsValue: currentSettingsValue,
      models: currentModels,
      providerSelection: currentProviderSelection,
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
          currentSettings.open(prefix.length, previousKey);
          return;
        }

        // Non-settings-backed: clear input and exit to text mode
        onChange('');
        setMode('text');
        return;
      }

      if (currentMode === 'provider_selection') {
        currentProviderSelection?.goBack();
        return;
      }

      if (currentMode === 'settings_value_completion' && currentSettingsValue.settingKey) {
        if (currentValue.startsWith(SETTINGS_TRIGGER)) {
          const prefix = SETTINGS_TRIGGER;
          onChange(prefix);
          setCursorOverride(prefix.length);

          const previousKey = currentSettingsValue.settingKey;
          currentSettingsValue.close();
          currentSettings.open(prefix.length, previousKey);
          return;
        }
      }

      if (currentMode === 'slash_commands' || currentMode === 'settings_completion') {
        onChange('');
        setMode('text');
        return;
      }

      if (currentMode === 'skill_selection') {
        dismissedCompletionRef.current = {
          type: 'skill_selection',
          inputRevision: inputRevisionRef.current,
        };
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

    // With text in the buffer, double Escape clears it — that stays the
    // meaning of the key even mid-turn. Only an already-empty buffer hands
    // Escape to the app-level interrupt confirmation, so the two double-Escape
    // gestures never fire off the same press. The predicate must stay
    // byte-identical to the one in `use-app-keyboard-shortcuts.ts`.
    if (stateRef.current.turnInFlight && currentValue.length === 0) return;

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
