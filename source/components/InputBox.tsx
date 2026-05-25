import React, { FC, useEffect, useState, useRef, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { useEscapeKey } from '../hooks/use-escape-key.js';
import { useTriggerDetection } from '../hooks/use-trigger-detection.js';
import { MultilineInput } from 'ink-prompt';
import type { ImageRef, PasteErrorReason } from 'ink-prompt';
import { useInputContext } from '../context/InputContext.js';
import { useSlashCommands } from '../hooks/use-slash-commands.js';
import { usePathCompletion } from '../hooks/use-path-completion.js';
import { useSettingsCompletion } from '../hooks/use-settings-completion.js';
import { useSettingsValueCompletion } from '../hooks/use-settings-value-completion.js';
import { useModelSelection } from '../hooks/use-model-selection.js';
import { useUndoSelection } from '../hooks/use-undo-selection.js';
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
import { SETTINGS_TRIGGER } from './Input/triggers.js';
import { parseSettingValue } from '../utils/settings-command.js';
import { getPopupNavigationCursor } from './Input/popup-key-navigation.js';
import { useModeHandlers } from '../hooks/use-mode-handlers.js';
import { toPopupProps } from './Input/popup-props.js';
import type { UserTurn } from '../types/user-turn.js';
import type { UndoItem } from '../hooks/use-undo-selection.js';

export { calculateInputWidth };

const areImagesEqual = (a: ImageRef[], b: ImageRef[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  return a.every((image, index) => {
    const other = b[index];
    return (
      other &&
      image.id === other.id &&
      image.data === other.data &&
      image.mimeType === other.mimeType &&
      image.byteSize === other.byteSize &&
      image.displayNumber === other.displayNumber
    );
  });
};

type Props = {
  onSubmit: (v: UserTurn) => void | Promise<void>;
  slashCommands: SlashCommand[];
  hasConversationHistory?: boolean;
  waitingForRejectionReason?: boolean;
  isShellMode?: boolean;
  settingsService: SettingsService;
  loggingService: LoggingService;
  historyService: HistoryService;
  onUndoSelect?: (item: UndoItem) => void;
  undoMenuRef?: React.MutableRefObject<{ open: (items: UndoItem[]) => void } | null>;
  onSettingChange?: (key: string, value: any) => void;
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
  onUndoSelect,
  undoMenuRef,
  onSettingChange,
}) => {
  const { input: value, setInput: onChange, mode, setMode, cursorOffset, setCursorOffset } = useInputContext();
  const [images, setImages] = useState<ImageRef[]>([]);

  const escPressedRef = useRef(false);
  const cursorOffsetRef = useRef(cursorOffset);
  const lockedCursorRef = useRef<number | null>(null);
  const [cursorOverride, setCursorOverride] = useState<number | null>(null);
  const settingsFilterRef = useRef('');
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
  const undo = useUndoSelection();

  // Wire up the undo menu ref so app.tsx can open the menu
  useEffect(() => {
    if (undoMenuRef) {
      undoMenuRef.current = { open: undo.open };
    }
    return () => {
      if (undoMenuRef) {
        undoMenuRef.current = null;
      }
    };
  }, [undo.open, undoMenuRef]);

  const { navigateUp, navigateDown } = useInputHistory(historyService);

  const [inputKey, setInputKey] = useState(0);
  const remountInput = useCallback(() => setInputKey((prev) => prev + 1), []);
  const lockCursor = useCallback((offset: number) => {
    lockedCursorRef.current = offset;
    setCursorOverride(offset);
    setTimeout(() => {
      if (lockedCursorRef.current === offset) {
        lockedCursorRef.current = null;
      }
    }, 20);
  }, []);
  const handleCursorChange = useCallback(
    (nextOffset: number) => {
      const lockedCursor = lockedCursorRef.current;
      if (lockedCursor !== null) {
        if (nextOffset !== lockedCursor) {
          lockedCursorRef.current = null;
          cursorOffsetRef.current = lockedCursor;
          setCursorOffset(lockedCursor);
          setCursorOverride(lockedCursor);
          remountInput();
          return;
        }
      }

      cursorOffsetRef.current = nextOffset;
      setCursorOffset(nextOffset);
    },
    [remountInput, setCursorOffset],
  );
  const handleImagesChange = useCallback((nextImages: ImageRef[]) => {
    setImages((prevImages) => (areImagesEqual(prevImages, nextImages) ? prevImages : nextImages));
  }, []);
  const submitTextOnly = useCallback(
    (text: string) => {
      setImages([]);
      void onSubmit({ text });
    },
    [onSubmit],
  );

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
    settingsFilterRef.current = settings.query;
    onChange(result.nextValue);
    setCursorOverride(result.nextCursor);
    settings.close();
    return true;
  }, [settings, value, onChange]);

  const insertSelectedSettingValue = useCallback(
    (submitAfterInsert: boolean, typedValue?: string): boolean => {
      const key = settingsValue.settingKey;

      if (submitAfterInsert && key) {
        // Apply the setting directly
        const suggestion = settingsValue.getSelectedItem();
        let parsedValue: any;

        if (suggestion) {
          parsedValue = parseSettingValue(suggestion.value);
        } else if (typedValue) {
          // Extract value from the typed input.
          // For /settings trigger: format is "/settings <key> <value>"
          // For direct triggers like /effort: format is "/effort <value>"
          const parts = typedValue.split(/\s+/).filter(Boolean);
          if (parts.length >= 2) {
            const valueParts = typedValue.startsWith(SETTINGS_TRIGGER) ? parts.slice(2) : parts.slice(1);
            if (valueParts.length > 0) {
              parsedValue = parseSettingValue(valueParts.join(' '));
            }
          }
        }

        if (parsedValue !== undefined) {
          try {
            settingsService.set(key, parsedValue);
            onSettingChange?.(key, parsedValue);
          } catch {
            // Continue even if setting fails
          }
        }

        // Close value menu
        settingsValue.close();

        // Only restore the settings completion menu when the input came from
        // /settings. Direct triggers like /effort or /auto-approve are top-level
        // menus — just close and clear the input after saving.
        const submittedValue = typedValue ?? value;
        if (submittedValue.startsWith(SETTINGS_TRIGGER)) {
          const filter = settingsFilterRef.current;
          const restoredInput = SETTINGS_TRIGGER + filter;
          onChange(restoredInput);
          setCursorOverride(restoredInput.length);
          settings.open(SETTINGS_TRIGGER.length, key);
        } else {
          onChange('');
        }
        return true;
      }

      // Non-submit (Tab) or missing key: existing insertion behavior
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
      return true;
    },
    [settingsValue, value, onChange, cursorOffset, settingsService, onSettingChange],
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

      if (submitAfterInsert && models.modelSettingConfig) {
        const modelId = models.getSelectedItem()?.id;
        if (!modelId) return false;

        const provider = models.provider;

        settingsService.set(models.modelSettingConfig.modelKey, modelId);
        if (provider) {
          settingsService.set(models.modelSettingConfig.providerKey, provider);
        }

        onSettingChange?.(models.modelSettingConfig.modelKey, modelId);
        if (provider) {
          onSettingChange?.(models.modelSettingConfig.providerKey, provider);
        }

        models.close();

        const restoredInput = SETTINGS_TRIGGER + settingsFilterRef.current;
        onChange(restoredInput);
        setCursorOverride(restoredInput.length);
        settings.open(SETTINGS_TRIGGER.length, models.modelSettingConfig.modelKey);
        return true;
      }

      onChange(result.nextValue);
      setCursorOverride(result.nextCursor);
      models.close();
      if (submitAfterInsert) {
        setImages([]);
        submitTextOnly(result.nextValue);
      }
      return true;
    },
    [models, value, onChange, submitTextOnly, settingsService, onSettingChange],
  );

  const modeHandlers = useModeHandlers({
    slash,
    path,
    settings,
    settingsValue,
    models,
    undo,
    insertSelectedPath,
    insertSelectedSetting,
    insertSelectedSettingValue,
    resetSettingValue: settingsValue.resetCurrentSetting,
    insertSelectedModel,
    onSubmit: submitTextOnly,
    onSlashCommandRemount: remountInput,
    onUndoSelect,
  });

  const stateRef = useRef({
    mode,
    modeHandlers,
    value,
    onChange,
    setCursorOffset,
    setCursorOverride,
    lockCursor,
    remountInput,
  });
  useEffect(() => {
    cursorOffsetRef.current = cursorOffset;
    stateRef.current = {
      mode,
      modeHandlers,
      value,
      onChange,
      setCursorOffset,
      setCursorOverride,
      lockCursor,
      remountInput,
    };
  });

  const { escHintVisible } = useEscapeKey({
    mode,
    setMode,
    value,
    onChange,
    settings,
    settingsValue,
    models,
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

  // Popup menus own input while open so MultilineInput cannot move the text cursor underneath them.
  useInput((_input, key) => {
    const {
      mode: currentMode,
      modeHandlers: currentHandlers,
      value: currentValue,
      onChange: changeInput,
      setCursorOffset: updateCursorOffset,
      setCursorOverride: overrideCursor,
      lockCursor: lockCurrentCursor,
      remountInput: remountCurrentInput,
    } = stateRef.current;
    const currentCursor = cursorOffsetRef.current;
    if (currentMode === 'text') return;
    const hasMoveLeft = Boolean(currentHandlers[currentMode].moveLeft);
    const hasMoveRight = Boolean(currentHandlers[currentMode].moveRight);

    const navigatedCursor = getPopupNavigationCursor({
      input: _input,
      key,
      cursor: currentCursor,
      valueLength: currentValue.length,
      hasModeLeftHandler: hasMoveLeft,
      hasModeRightHandler: hasMoveRight,
    });
    if (navigatedCursor !== null) {
      cursorOffsetRef.current = navigatedCursor;
      updateCursorOffset(navigatedCursor);
      overrideCursor(navigatedCursor);
      return;
    }

    if (key.upArrow) {
      currentHandlers[currentMode].moveUp();
      return;
    }
    if (key.downArrow) {
      currentHandlers[currentMode].moveDown();
      return;
    }
    if (key.pageUp) {
      currentHandlers[currentMode].pageUp?.();
      return;
    }
    if (key.pageDown) {
      currentHandlers[currentMode].pageDown?.();
      return;
    }
    if ((key as any).home) {
      currentHandlers[currentMode].moveHome?.();
      return;
    }
    if ((key as any).end) {
      currentHandlers[currentMode].moveEnd?.();
      return;
    }
    if (key.tab && !key.shift) {
      currentHandlers[currentMode].onTab?.();
      return;
    }
    if (key.leftArrow && currentHandlers[currentMode].moveLeft) {
      lockCurrentCursor(currentCursor);
      currentHandlers[currentMode].moveLeft?.();
      remountCurrentInput();
      return;
    }
    if (key.rightArrow && currentHandlers[currentMode].moveRight) {
      lockCurrentCursor(currentCursor);
      currentHandlers[currentMode].moveRight?.();
      remountCurrentInput();
      return;
    }
    if (key.return) {
      currentHandlers[currentMode].onSubmit?.(currentValue);
      return;
    }
    if (key.ctrl && _input === 'd' && currentHandlers[currentMode].onReset) {
      currentHandlers[currentMode].onReset?.();
      return;
    }
    if (key.backspace) {
      if (currentMode === 'undo_selection') return;
      if (currentCursor <= 0) return;
      const nextValue = currentValue.slice(0, currentCursor - 1) + currentValue.slice(currentCursor);
      const nextCursor = currentCursor - 1;
      changeInput(nextValue);
      cursorOffsetRef.current = nextCursor;
      updateCursorOffset(nextCursor);
      overrideCursor(nextCursor);
      return;
    }
    if (key.delete) {
      if (currentMode === 'undo_selection') return;
      if (currentCursor >= currentValue.length) return;
      const nextValue = currentValue.slice(0, currentCursor) + currentValue.slice(currentCursor + 1);
      changeInput(nextValue);
      overrideCursor(currentCursor);
      return;
    }
    if (
      _input &&
      !key.ctrl &&
      !key.meta &&
      !key.escape &&
      !key.tab &&
      !key.return &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow
    ) {
      // Ignore character input in undo_selection mode
      if (currentMode === 'undo_selection') return;
      const nextValue = currentValue.slice(0, currentCursor) + _input + currentValue.slice(currentCursor);
      const nextCursor = currentCursor + _input.length;
      changeInput(nextValue);
      cursorOffsetRef.current = nextCursor;
      updateCursorOffset(nextCursor);
      overrideCursor(nextCursor);
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
      const next = direction === 'up' ? navigateUp({ text: value, images }) : navigateDown();
      if (next !== null) {
        onChange(next.text);
        setImages((prevImages) => (areImagesEqual(prevImages, next.images ?? []) ? prevImages : next.images ?? []));
        remountInput();
      }
    },
    [mode, modeHandlers, navigateUp, navigateDown, value, images, onChange, remountInput],
  );

  const handleWrapperSubmit = useCallback(
    (submittedValue: string, submittedImages?: ImageRef[]) => {
      if (mode !== 'text' && modeHandlers[mode].onSubmit?.(submittedValue) === 'handled') return;
      const turnImages = submittedImages ?? images;
      if (!submittedValue.trim() && turnImages.length === 0) return;
      setImages([]);
      void onSubmit({ text: submittedValue, ...(turnImages.length ? { images: turnImages } : {}) });
    },
    [mode, modeHandlers, onSubmit, images],
  );

  const handlePasteError = useCallback(
    (reason: PasteErrorReason) => {
      loggingService.warn('Image paste failed', { reason });
    },
    [loggingService],
  );

  return (
    <Box flexDirection="column">
      <PopupManager
        {...toPopupProps({ slash, path, settings, settingsValue, models, undo })}
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
          key={`${mode}-${inputKey}`}
          value={value}
          width={terminalWidth}
          isActive={mode === 'text'}
          onChange={onChange}
          onSubmit={handleWrapperSubmit}
          onCursorChange={handleCursorChange}
          cursorOverride={cursorOverride ?? undefined}
          onBoundaryArrow={handleBoundaryArrow}
          enableImagePaste
          images={images}
          onImagesChange={handleImagesChange}
          onPasteError={handlePasteError}
          pasteThreshold={settingsService.get<number | undefined>('ui.pasteThreshold')}
        />
      </Box>
      {escHintVisible && <Text color="#64748b">Press ESC again to clear input</Text>}
      {waitingForRejectionReason && <Text color="#64748b">(or ESC to cancel)</Text>}
    </Box>
  );
};

export default React.memo(InputBox);
