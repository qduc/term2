import React, { FC, useEffect, useState, useRef, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { useEscapeKey } from '../hooks/use-escape-key.js';
import { useTriggerDetection } from '../hooks/use-trigger-detection.js';
import { MultilineInput } from 'ink-prompt';
import { useInputContext } from '../context/InputContext.js';
import { useSlashCommands } from '../hooks/use-slash-commands.js';
import { usePathCompletion } from '../hooks/use-path-completion.js';
import { useSettingsCompletion } from '../hooks/use-settings-completion.js';
import { useSettingsValueCompletion } from '../hooks/use-settings-value-completion.js';
import { useModelSelection } from '../hooks/use-model-selection.js';
import { PopupManager } from './Input/PopupManager.js';
import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings-service.js';
import type { LoggingService } from '../services/logging-service.js';
import type { HistoryService } from '../services/history-service.js';
import { useInputHistory } from '../hooks/use-input-history.js';
import { useTerminalWidth } from '../hooks/use-terminal-width.js';
import { calculateInputWidth } from './Input/input-width.js';
import {
  computePathInsertion,
  computeSettingInsertion,
  computeSettingValueInsertion,
  computeModelInsertion,
} from './Input/insertions.js';
import { useModeHandlers } from '../hooks/use-mode-handlers.js';
import { toPopupProps } from './Input/popup-props.js';

export { calculateInputWidth };

type Props = {
  onSubmit: (v: string) => void;
  slashCommands: SlashCommand[];
  hasConversationHistory?: boolean;
  waitingForRejectionReason?: boolean;
  isShellMode?: boolean;
  settingsService: SettingsService;
  loggingService: LoggingService;
  historyService: HistoryService;
};

const InputBox: FC<Props> = ({
  onSubmit,
  slashCommands,
  settingsService,
  loggingService,
  hasConversationHistory = false,
  waitingForRejectionReason = false,
  isShellMode = false,
  historyService,
}) => {
  const { input: value, setInput: onChange, mode, setMode, cursorOffset, setCursorOffset } = useInputContext();

  const escPressedRef = useRef(false);
  const [cursorOverride, setCursorOverride] = useState<number | null>(null);
  const terminalWidth = useTerminalWidth({ waitingForRejectionReason, isShellMode });

  // Hooks
  const slash = useSlashCommands({
    commands: slashCommands,
    onClose: () => {
      // Focus returns to text mode automatically via hook
    },
  });

  const path = usePathCompletion({ loggingService });
  const settings = useSettingsCompletion(settingsService);
  const settingsValue = useSettingsValueCompletion(settingsService);
  const models = useModelSelection(
    {
      loggingService,
      settingsService,
    },
    hasConversationHistory,
  );

  const { navigateUp, navigateDown } = useInputHistory(historyService);

  const [, setInputKey] = useState(0);
  const remountInput = useCallback(() => setInputKey((prev) => prev + 1), []);

  const insertSelectedPath = useCallback(
    (appendTrailingSpace: boolean): boolean => {
      const result = computePathInsertion({
        selection: path.getSelectedItem(),
        triggerIndex: path.triggerIndex,
        value,
        cursorOffset,
        appendTrailingSpace,
      });
      if (!result) return false;
      onChange(result.nextValue);
      setCursorOverride(result.nextCursor);
      path.close();
      return true;
    },
    [path, cursorOffset, value, onChange],
  );

  const insertSelectedSetting = useCallback((): boolean => {
    const result = computeSettingInsertion({ selection: settings.getSelectedItem(), value });
    if (!result) return false;
    onChange(result.nextValue);
    setCursorOverride(result.nextCursor);
    settings.close();
    return true;
  }, [settings, value, onChange]);

  const insertSelectedSettingValue = useCallback(
    (submitAfterInsert: boolean): boolean => {
      const result = computeSettingValueInsertion({
        suggestion: settingsValue.getSelectedItem(),
        settingKey: settingsValue.settingKey,
        triggerIndex: settingsValue.triggerIndex,
        value,
        cursorOffset,
      });
      if (!result) return false;
      onChange(result.nextValue);
      setCursorOverride(result.nextCursor);
      settingsValue.close();
      if (submitAfterInsert) onSubmit(result.nextValue);
      return true;
    },
    [settingsValue, value, onChange, cursorOffset, onSubmit],
  );

  const insertSelectedModel = useCallback(
    (submitAfterInsert: boolean): boolean => {
      const result = computeModelInsertion({
        selection: models.getSelectedItem(),
        triggerIndex: models.triggerIndex,
        provider: models.provider,
        value,
        appendTrailingSpace: !submitAfterInsert,
      });
      if (!result) return false;
      onChange(result.nextValue);
      setCursorOverride(result.nextCursor);
      models.close();
      if (submitAfterInsert) onSubmit(result.nextValue);
      return true;
    },
    [models, value, onChange, onSubmit],
  );

  const modeHandlers = useModeHandlers({
    slash,
    path,
    settings,
    settingsValue,
    models,
    insertSelectedPath,
    insertSelectedSetting,
    insertSelectedSettingValue,
    insertSelectedModel,
    onSubmit,
    onSlashCommandRemount: remountInput,
  });

  const stateRef = useRef({ mode, modeHandlers });
  useEffect(() => {
    stateRef.current = { mode, modeHandlers };
  });

  const { escHintVisible } = useEscapeKey({
    mode,
    setMode,
    value,
    onChange,
    settings,
    settingsValue,
    setCursorOverride,
    escPressedRef,
  });

  useEffect(() => {
    if (cursorOverride !== null && cursorOverride === cursorOffset) {
      setCursorOverride(null);
    }
  }, [cursorOverride, cursorOffset]);

  useTriggerDetection({
    value,
    cursorOffset,
    mode,
    escPressedRef,
    slash,
    path,
    settings,
    settingsValue,
    models,
    slashCommands,
  });

  // Tab handling for active menu (other keys flow to MultilineInput).
  useInput((_input, key) => {
    const { mode: currentMode, modeHandlers: currentHandlers } = stateRef.current;
    if (currentMode === 'text') return;
    if (key.tab && !key.shift) {
      currentHandlers[currentMode].onTab?.();
    }
  });

  const handleBoundaryArrow = useCallback(
    (direction: 'up' | 'down' | 'left' | 'right') => {
      if (direction !== 'up' && direction !== 'down') return;

      if (mode !== 'text') {
        const handler = modeHandlers[mode];
        if (direction === 'up') handler.moveUp();
        else handler.moveDown();
        return;
      }

      // In text mode, arrows traverse input history.
      const next = direction === 'up' ? navigateUp(value) : navigateDown();
      if (next !== null) {
        onChange(next);
        remountInput();
      }
    },
    [mode, modeHandlers, navigateUp, navigateDown, value, onChange, remountInput],
  );

  const handleWrapperSubmit = useCallback(
    (submittedValue: string) => {
      if (mode !== 'text' && modeHandlers[mode].onSubmit?.(submittedValue) === 'handled') return;
      onSubmit(submittedValue);
    },
    [mode, modeHandlers, onSubmit],
  );

  return (
    <Box flexDirection="column">
      <PopupManager
        {...toPopupProps({ slash, path, settings, settingsValue, models })}
        settingsService={settingsService}
      />
      <Box>
        {waitingForRejectionReason ? (
          <Text color="yellow">Why? </Text>
        ) : isShellMode ? (
          <Text color="green">$ </Text>
        ) : (
          <Text color="#22d3ee">❯ </Text>
        )}
        <MultilineInput
          value={value}
          width={terminalWidth}
          onChange={onChange}
          onSubmit={handleWrapperSubmit}
          onCursorChange={setCursorOffset}
          cursorOverride={cursorOverride ?? undefined}
          onBoundaryArrow={handleBoundaryArrow}
        />
      </Box>
      {escHintVisible && <Text color="#64748b">Press ESC again to clear input</Text>}
      {waitingForRejectionReason && <Text color="#64748b">(or ESC to cancel)</Text>}
    </Box>
  );
};

export default React.memo(InputBox);
