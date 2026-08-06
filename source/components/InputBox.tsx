import React, { FC, useEffect, useState, useRef, useCallback } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { useEscapeKey, type CompletionDismissal } from '../hooks/use-escape-key.js';
import { useTriggerDetection } from '../hooks/use-trigger-detection.js';
import { MultilineInput } from 'ink-prompt';
import type { ImageRef, PasteErrorReason } from 'ink-prompt';
import { useInputContext } from '../context/InputContext.js';
import { useSlashCommands } from '../hooks/use-slash-commands.js';
import { usePathCompletion } from '../hooks/use-path-completion.js';
import { useSettingsCompletion } from '../hooks/use-settings-completion.js';
import { useSettingsValueCompletion } from '../hooks/use-settings-value-completion.js';
import { useModelSelection } from '../hooks/use-model-selection.js';
import { useRewindSelection } from '../hooks/use-rewind-selection.js';
import { useProviderSelection } from '../hooks/use-provider-selection.js';
import type { ProviderSelectionPhase } from '../hooks/use-provider-selection.js';
import { useSkillSelection } from '../hooks/use-skill-selection.js';
import type { SkillsService } from '../services/skills/skills-service.js';
import { PopupManager } from './input/PopupManager.js';
import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import type { LoggingService } from '../services/logging/logging-service.js';
import type { HistoryService } from '../services/history-service.js';
import { useInputHistory } from '../hooks/use-input-history.js';
import { useTerminalWidth } from '../hooks/use-terminal-width.js';
import { calculateInputWidth } from './input/input-width.js';
import {
  computePathInsertion,
  computeSettingInsertion,
  computeSettingValueInsertion,
  computeModelInsertion,
  computeSkillInsertion,
  type Insertion,
} from './input/insertions.js';
import { SETTINGS_TRIGGER } from './input/triggers.js';
import { parseSettingValue } from '../utils/settings-command.js';
import { getPopupNavigationCursor } from './input/popup-key-navigation.js';
import { useModeHandlers } from '../hooks/use-mode-handlers.js';
import { toPopupProps } from './input/popup-props.js';
import type { UserTurn } from '../types/user-turn.js';
import type { RewindItem } from '../hooks/use-rewind-selection.js';
import type { RewindDisposition } from '../commands/rewind-command.js';
import type { SubmissionMutation } from '../services/conversation/conversation-adapter.js';
import PendingQueueList, { type PendingQueueMessage } from './input/PendingQueueList.js';

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
  onSubmit: (v: UserTurn, options?: { busyMode?: 'steer' | 'follow_up' }) => void | Promise<void>;
  slashCommands: SlashCommand[];
  waitingForRejectionReason?: boolean;
  isShellMode?: boolean;
  settingsService: SettingsService;
  loggingService: LoggingService;
  historyService: HistoryService;
  onRewindSelect?: (item: RewindItem, disposition: RewindDisposition) => void;
  rewindMenuRef?: React.MutableRefObject<{
    open: (items: RewindItem[], disposition: RewindDisposition) => void;
  } | null>;
  providersMenuRef?: React.MutableRefObject<{ open: () => void } | null>;
  onSettingChange?: (key: string, value: any) => void;
  onSystemMessage?: (text: string) => void;
  onSlashTabComplete?: (command: SlashCommand) => boolean;
  promptLabel?: string;
  allowEmptySubmit?: boolean;
  skillsService?: SkillsService;
  pendingQueuedMessages?: ReadonlyArray<PendingQueueMessage>;
  onRetractQueuedMessage?: (id: string) => Promise<SubmissionMutation>;
  onEditQueuedMessage?: (id: string, turn: UserTurn) => Promise<SubmissionMutation>;
};

const isFocusReportingSequence = (input: string): boolean => {
  return input === '\x1b[I' || input === '\x1b[O' || input === '[I' || input === '[O';
};

const parseSubmittedSettingValue = (submittedValue: string, startsWithSettingsTrigger: boolean): any => {
  const parts = submittedValue.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }

  const valueParts = startsWithSettingsTrigger ? parts.slice(2) : parts.slice(1);
  if (valueParts.length === 0) {
    return undefined;
  }

  return parseSettingValue(valueParts.join(' '));
};

export const getProviderWizardPromptLabel = (phase: ProviderSelectionPhase): string | undefined => {
  if (phase === 'wizard_name') return 'Enter Provider Name: ';
  if (phase === 'wizard_url') return 'Enter Base API URL: ';
  if (phase === 'wizard_key') return 'Enter API Key: ';
  return undefined;
};

const InputBox: FC<Props> = ({
  onSubmit,
  slashCommands,
  settingsService,
  loggingService,
  waitingForRejectionReason = false,
  isShellMode = false,
  historyService,
  onRewindSelect,
  rewindMenuRef,
  providersMenuRef,
  onSettingChange,
  onSystemMessage,
  onSlashTabComplete,
  promptLabel,
  allowEmptySubmit = false,
  skillsService,
  pendingQueuedMessages,
  onRetractQueuedMessage,
  onEditQueuedMessage,
}) => {
  const {
    input: value,
    setInput: onChange,
    mode,
    setMode,
    cursorOffset,
    setCursorOffset,
    images,
    setImages,
    cursorOverride,
    setCursorOverride,
  } = useInputContext();
  const { stdin } = useStdin();
  const stdinBufferRef = useRef('');
  const stdinBufferTimestampRef = useRef(0);
  const consumedAltEnterRef = useRef(false);

  const dismissedCompletionRef = useRef<CompletionDismissal>(null);
  const inputRevisionRef = useRef(0);
  const inputValueRef = useRef(value);
  inputValueRef.current = value;
  const cursorOffsetRef = useRef(cursorOffset);
  const lockedCursorRef = useRef<number | null>(null);
  const settingsFilterRef = useRef('');
  // Stores a cursor position that should be applied *after* a popup menu closes
  // and the new value has already been synced to MultilineInput. Updating both
  // value and cursorOverride in the same render is overwritten by ink-prompt's
  // value-sync effect, so we defer the cursor override to a separate commit.
  const pendingCursorOverrideRef = useRef<{ value: string; cursor: number } | null>(null);
  // Guard that suppresses the stale onImagesChange callback fired by ink-prompt's
  // MultilineInput after a controlled images prop change (history recall, paste, etc.).
  // ink-prompt syncs images via two unbuffered effects — one pushes the prop into
  // internal state, the other reports internal state back — but without the
  // isSyncingFromProps guard that the value prop already has, causing an oscillation.
  const suppressImagesCallbackRef = useRef(false);

  // Hooks
  const slash = useSlashCommands({
    commands: slashCommands,
    onClose: () => {
      // Focus returns to text mode automatically via hook
    },
  });

  const path = usePathCompletion({ loggingService });
  const settings = useSettingsCompletion(settingsService);
  const reopenSettingsMenu = useCallback(
    (key: string) => {
      const filter = settingsFilterRef.current;
      const restoredInput = SETTINGS_TRIGGER + filter;
      onChange(restoredInput);
      setCursorOffset(restoredInput.length);
      setCursorOverride(restoredInput.length);
      settings.open(SETTINGS_TRIGGER.length, key);
    },
    [onChange, setCursorOffset, setCursorOverride, settings],
  );
  const settingsValue = useSettingsValueCompletion(settingsService, {
    onReset: reopenSettingsMenu,
  });
  const models = useModelSelection({
    loggingService,
    settingsService,
  });
  const rewind = useRewindSelection();
  const providers = useProviderSelection(settingsService);

  const skills = useSkillSelection(
    skillsService ? { skillsService } : { skillsService: { getAvailableSkills: () => [] } as unknown as SkillsService },
  );

  const [inputKey, setInputKey] = useState(0);
  const [queueSelectionIndex, setQueueSelectionIndex] = useState<number | null>(null);
  const [editingQueueItem, setEditingQueueItem] = useState<{ id: string; restoreInput: string } | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const queueSelectionIndexRef = useRef<number | null>(queueSelectionIndex);
  const queueSelectionJustOpenedRef = useRef(false);
  const editingQueueItemRef = useRef<{ id: string; restoreInput: string } | null>(editingQueueItem);
  const pendingQueuedMessagesRef = useRef<ReadonlyArray<PendingQueueMessage>>(pendingQueuedMessages ?? []);
  queueSelectionIndexRef.current = queueSelectionIndex;
  editingQueueItemRef.current = editingQueueItem;
  pendingQueuedMessagesRef.current = pendingQueuedMessages ?? [];
  const updateQueueSelection = useCallback((next: number | null) => {
    queueSelectionIndexRef.current = next;
    setQueueSelectionIndex(next);
  }, []);

  const providerWizardPromptLabel = getProviderWizardPromptLabel(providers.phase);
  const editingQueueIndex = editingQueueItem
    ? pendingQueuedMessages?.findIndex((message) => message.id === editingQueueItem.id)
    : -1;
  const activePromptLabel =
    providerWizardPromptLabel ?? (editingQueueItem ? `edit ${(editingQueueIndex ?? -1) + 1} ▸ ` : promptLabel);
  const terminalWidth = useTerminalWidth({ waitingForRejectionReason, isShellMode, promptLabel: activePromptLabel });

  // Wire up the rewind menu ref so app.tsx can open the picker
  useEffect(() => {
    if (rewindMenuRef) {
      rewindMenuRef.current = { open: rewind.open };
    }
    return () => {
      if (rewindMenuRef) {
        rewindMenuRef.current = null;
      }
    };
  }, [rewind.open, rewindMenuRef]);

  // Wire up the providers menu ref so app.tsx can control it
  useEffect(() => {
    if (providersMenuRef) {
      providersMenuRef.current = { open: providers.open };
    }
    return () => {
      if (providersMenuRef) {
        providersMenuRef.current = null;
      }
    };
  }, [providers.open, providersMenuRef]);

  const { navigateUp, navigateDown } = useInputHistory(historyService);

  const remountInput = useCallback(() => setInputKey((prev) => prev + 1), []);
  const lockCursor = useCallback(
    (offset: number) => {
      lockedCursorRef.current = offset;
      setCursorOverride(offset);
      setTimeout(() => {
        if (lockedCursorRef.current === offset) {
          lockedCursorRef.current = null;
        }
      }, 20);
    },
    [setCursorOverride],
  );
  const handleCursorChange = useCallback(
    (nextOffset: number) => {
      // When a popup menu is open MultilineInput is inactive. The only cursor
      // changes it reports come from the value-sync effect (setText resets
      // cursor to end), which would overwrite our correct cursorOffset. Ignore
      // all cursor changes in non-text mode.
      if (mode !== 'text') return;

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
    [mode, remountInput, setCursorOffset, setCursorOverride],
  );
  const handleImagesChange = useCallback(
    (nextImages: ImageRef[]) => {
      if (suppressImagesCallbackRef.current) {
        suppressImagesCallbackRef.current = false;
        return;
      }
      setImages((prevImages) => (areImagesEqual(prevImages, nextImages) ? prevImages : nextImages));
    },
    [setImages],
  );
  const submitTextOnly = useCallback(
    (text: string) => {
      setImages([]);
      void onSubmit({ text });
    },
    [onSubmit, setImages],
  );
  const applyAutocompleteInsertion = useCallback(
    (result: Insertion) => {
      onChange(result.nextValue);
      cursorOffsetRef.current = result.nextCursor;
      setCursorOffset(result.nextCursor);
      pendingCursorOverrideRef.current = { value: result.nextValue, cursor: result.nextCursor };
    },
    [onChange, setCursorOffset],
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
      applyAutocompleteInsertion(result);
      path.close();
      return true;
    },
    [path, cursorOffset, value, applyAutocompleteInsertion],
  );

  const insertSelectedSetting = useCallback((): boolean => {
    const result = computeSettingInsertion({ selection: settings.getSelectedItem(), value });
    if (!result) return false;
    settingsFilterRef.current = settings.query;
    applyAutocompleteInsertion(result);
    settings.close();
    return true;
  }, [settings, value, applyAutocompleteInsertion]);

  const insertSelectedSettingValue = useCallback(
    (submitAfterInsert: boolean, typedValue?: string): boolean => {
      const key = settingsValue.settingKey;

      if (submitAfterInsert && key) {
        // Apply the setting directly
        const suggestion = settingsValue.getSelectedItem();
        const submittedValue = typedValue ?? value;
        const startsWithSettingsTrigger = submittedValue.startsWith(SETTINGS_TRIGGER);
        const parsedTypedValue = typedValue
          ? parseSubmittedSettingValue(submittedValue, startsWithSettingsTrigger)
          : undefined;
        const parsedSuggestionValue = suggestion ? parseSettingValue(suggestion.value) : undefined;
        const shouldPreferTypedNumericValue =
          settingsValue.isNumericSettings &&
          parsedTypedValue !== undefined &&
          String(parsedTypedValue) !== suggestion?.value;

        const parsedValue = shouldPreferTypedNumericValue
          ? parsedTypedValue
          : parsedSuggestionValue ?? parsedTypedValue;

        if (parsedValue !== undefined) {
          try {
            if (settingsService.isRuntimeModifiable(key)) {
              settingsService.setDynamic(key, parsedValue);
              onSettingChange?.(key, parsedValue);
            } else {
              settingsService.setPersistentDynamic(key, parsedValue);
              onSystemMessage?.(`Saved ${key} = ${parsedValue}. This setting applies after restart.`);
            }
          } catch {
            // Continue even if setting fails
          }
        }

        // Close value menu
        settingsValue.close();

        // Only restore the settings completion menu when the input came from
        // /settings. Direct triggers like /effort or /auto-approve are top-level
        // menus — just close and clear the input after saving.
        if (submittedValue.startsWith(SETTINGS_TRIGGER)) {
          reopenSettingsMenu(key);
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
      applyAutocompleteInsertion(result);
      settingsValue.close();
      return true;
    },
    [
      settingsValue,
      value,
      onChange,
      cursorOffset,
      applyAutocompleteInsertion,
      settingsService,
      onSettingChange,
      onSystemMessage,
      reopenSettingsMenu,
    ],
  );

  const insertSelectedModel = useCallback(
    (submitAfterInsert: boolean): boolean => {
      const selectedModel = models.getSelectedItem();
      const typedModelId = models.query.trim();
      const resolvedModelId = selectedModel?.id ?? (submitAfterInsert ? typedModelId : undefined);

      const result = computeModelInsertion({
        selection: selectedModel,
        modelId: resolvedModelId,
        triggerIndex: models.triggerIndex,
        provider: models.provider,
        value,
        appendTrailingSpace: !submitAfterInsert,
        includeProvider: submitAfterInsert,
      });
      if (!result) return false;

      if (submitAfterInsert && models.modelSettingConfig) {
        const modelId = resolvedModelId;
        if (!modelId) return false;

        const provider = models.provider;

        settingsService.setDynamic(models.modelSettingConfig.modelKey, modelId);
        if (provider) {
          settingsService.setDynamic(models.modelSettingConfig.providerKey, provider);
        }

        onSettingChange?.(models.modelSettingConfig.modelKey, modelId);
        if (provider) {
          onSettingChange?.(models.modelSettingConfig.providerKey, provider);
        }

        models.close();

        reopenSettingsMenu(models.modelSettingConfig.modelKey);
        return true;
      }

      if (submitAfterInsert) {
        onChange(result.nextValue);
        models.close();
        submitTextOnly(result.nextValue);
        return true;
      }

      applyAutocompleteInsertion(result);
      models.close();
      return true;
    },
    [
      models,
      value,
      onChange,
      submitTextOnly,
      settingsService,
      onSettingChange,
      applyAutocompleteInsertion,
      reopenSettingsMenu,
    ],
  );

  const insertSelectedSkill = useCallback(
    (submitAfterInsert: boolean): boolean => {
      const result = computeSkillInsertion({
        selection: skills.getSelectedItem(),
        triggerIndex: skills.triggerIndex,
        value,
        cursorOffset,
        appendTrailingSpace: true,
      });
      if (!result) return false;

      if (submitAfterInsert) {
        onChange(result.nextValue);
        skills.close();
        submitTextOnly(result.nextValue);
        return true;
      }

      applyAutocompleteInsertion(result);
      skills.close();
      return true;
    },
    [skills, value, cursorOffset, onChange, submitTextOnly, applyAutocompleteInsertion],
  );

  const modeHandlers = useModeHandlers({
    slash,
    path,
    settings,
    settingsValue,
    models,
    skills: {
      moveUp: skills.moveUp,
      moveDown: skills.moveDown,
      moveHome: skills.moveHome,
      moveEnd: skills.moveEnd,
      pageUp: skills.pageUp,
      pageDown: skills.pageDown,
    },
    rewind,
    providers,
    insertSelectedPath,
    insertSelectedSetting,
    insertSelectedSettingValue,
    resetSettingValue: settingsValue.resetCurrentSetting,
    insertSelectedModel,
    insertSelectedSkill,
    onSubmit: submitTextOnly,
    onSlashCommandRemount: remountInput,
    onSlashTabComplete,
    onRewindSelect,
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
    providersPhase: providers.phase,
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
      providersPhase: providers.phase,
    };
  });

  const cancelQueueInteraction = useCallback((): boolean => {
    if (queueSelectionIndexRef.current !== null) {
      updateQueueSelection(null);
      return true;
    }
    if (editingQueueItemRef.current) {
      onChange(editingQueueItemRef.current.restoreInput);
      setEditingQueueItem(null);
      return true;
    }
    return false;
  }, [onChange, updateQueueSelection]);

  const { escHintVisible } = useEscapeKey({
    mode,
    setMode,
    value,
    onChange,
    settings,
    settingsValue,
    models,
    providerSelection: providers,
    setCursorOverride,
    dismissedCompletionRef,
    inputRevisionRef,
    onEscape: cancelQueueInteraction,
  });

  // When a non-text mode is active (popup menu), keep cursorOverride in sync so
  // MultilineInput always knows the cursor position when it becomes active again.
  useEffect(() => {
    if (mode !== 'text' && cursorOverride !== cursorOffset) {
      setCursorOverride(cursorOffset);
    }
  }, [mode, cursorOffset, cursorOverride, setCursorOverride]);

  // Only clear cursorOverride in text mode to avoid losing cursor position
  // when a popup menu handles character input and leaves MultilineInput inactive.
  useEffect(() => {
    if (cursorOverride !== null && cursorOverride === cursorOffset && mode === 'text') {
      setCursorOverride(null);
    }
  }, [cursorOverride, cursorOffset, mode, setCursorOverride]);

  // After a popup menu closes and the new value has been synced to
  // MultilineInput, apply any pending cursor override. We intentionally defer
  // this to a separate commit so the value-sync effect (which resets the cursor
  // to the end) does not overwrite the override.
  useEffect(() => {
    if (mode === 'text' && pendingCursorOverrideRef.current !== null) {
      const { value: expectedValue, cursor } = pendingCursorOverrideRef.current;
      pendingCursorOverrideRef.current = null;
      if (value === expectedValue) {
        setCursorOverride(cursor);
      }
    }
  }, [mode, value, setCursorOverride]);

  useTriggerDetection({
    value,
    cursorOffset,
    mode,
    dismissedCompletionRef,
    inputRevisionRef,
    slash,
    path,
    settings,
    settingsValue,
    models,
    skills,
    slashCommands,
  });

  // Popup menus own input while open so MultilineInput cannot move the text cursor underneath them.
  useInput((_input, key) => {
    const {
      mode: currentMode,
      modeHandlers: currentHandlers,
      onChange: changeInput,
      setCursorOffset: updateCursorOffset,
      setCursorOverride: overrideCursor,
      lockCursor: lockCurrentCursor,
      remountInput: remountCurrentInput,
      providersPhase,
    } = stateRef.current;
    const currentValue = inputValueRef.current;
    const currentCursor = cursorOffsetRef.current;
    const selectedQueueIndex = queueSelectionIndexRef.current;
    const currentQueuedMessages = pendingQueuedMessagesRef.current;
    if (currentMode === 'text' && selectedQueueIndex !== null) {
      if (queueSelectionJustOpenedRef.current) {
        queueSelectionJustOpenedRef.current = false;
        return;
      }
      const selectedMessage = currentQueuedMessages[selectedQueueIndex];
      if (!selectedMessage) {
        updateQueueSelection(null);
        return;
      }
      if (key.upArrow) {
        if (selectedQueueIndex > 0) {
          updateQueueSelection(selectedQueueIndex - 1);
          return;
        }
        updateQueueSelection(null);
        const previous = navigateUp({ text: currentValue, images });
        if (previous !== null) {
          changeInput(previous.text);
          suppressImagesCallbackRef.current = true;
          setImages((previousImages) =>
            areImagesEqual(previousImages, previous.images ?? []) ? previousImages : previous.images ?? [],
          );
          remountCurrentInput();
        }
        return;
      }
      if (key.downArrow) {
        if (selectedQueueIndex < currentQueuedMessages.length - 1) {
          updateQueueSelection(selectedQueueIndex + 1);
        } else {
          updateQueueSelection(null);
        }
        return;
      }
      if (_input === 'e' || key.return) {
        setQueueNotice(null);
        setEditingQueueItem({ id: selectedMessage.id, restoreInput: currentValue });
        updateQueueSelection(null);
        changeInput(selectedMessage.text);
        updateCursorOffset(selectedMessage.text.length);
        overrideCursor(selectedMessage.text.length);
        return;
      }
      if (_input === 'd') {
        if (!onRetractQueuedMessage) return;
        void onRetractQueuedMessage(selectedMessage.id).then((result) => {
          updateQueueSelection(null);
          if (result.kind === 'too_late') setQueueNotice('already sent — the model has it');
          else if (result.kind === 'unknown_id') setQueueNotice('queued message is no longer available');
        });
        return;
      }
      return;
    }
    if (currentMode === 'text') return;

    // Ignore focus-in and focus-out escape sequences (both raw and split variants)
    if (isFocusReportingSequence(_input)) {
      return;
    }

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
    if (key.ctrl && _input === 'r' && currentHandlers[currentMode].onRefresh) {
      currentHandlers[currentMode].onRefresh?.();
      return;
    }
    if (key.ctrl && _input === 'd' && currentHandlers[currentMode].onReset) {
      currentHandlers[currentMode].onReset?.();
      return;
    }
    if (key.backspace) {
      if (currentMode === 'rewind_selection') return;
      if (currentMode === 'provider_selection') {
        if (providersPhase !== 'wizard_name' && providersPhase !== 'wizard_url' && providersPhase !== 'wizard_key') {
          currentHandlers[currentMode].onDelete?.();
          return;
        }
      }
      if (currentCursor <= 0) return;
      const nextValue = currentValue.slice(0, currentCursor - 1) + currentValue.slice(currentCursor);
      const nextCursor = currentCursor - 1;
      inputValueRef.current = nextValue;
      changeInput(nextValue);
      cursorOffsetRef.current = nextCursor;
      updateCursorOffset(nextCursor);
      // Don't call overrideCursor here for the same reason as char insertion
      // — see comment above.
      return;
    }
    if (key.delete) {
      if (currentMode === 'rewind_selection') return;
      if (currentMode === 'provider_selection') {
        if (providersPhase !== 'wizard_name' && providersPhase !== 'wizard_url' && providersPhase !== 'wizard_key') {
          currentHandlers[currentMode].onDelete?.();
          return;
        }
      }
      if (currentCursor >= currentValue.length) return;
      const nextValue = currentValue.slice(0, currentCursor) + currentValue.slice(currentCursor + 1);
      inputValueRef.current = nextValue;
      changeInput(nextValue);
      overrideCursor(currentCursor);
      return;
    }
    if (_input === '[' && currentHandlers[currentMode].onMoveItemUp) {
      currentHandlers[currentMode].onMoveItemUp?.();
      return;
    }
    if (_input === ']' && currentHandlers[currentMode].onMoveItemDown) {
      currentHandlers[currentMode].onMoveItemDown?.();
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
      // Ignore character input in rewind_selection mode
      if (currentMode === 'rewind_selection') return;
      const nextValue = currentValue.slice(0, currentCursor) + _input + currentValue.slice(currentCursor);
      const nextCursor = currentCursor + _input.length;
      inputValueRef.current = nextValue;
      changeInput(nextValue);
      cursorOffsetRef.current = nextCursor;
      updateCursorOffset(nextCursor);
      // Do NOT call overrideCursor here — when a popup menu is open,
      // MultilineInput applies cursorOverride BEFORE value sync (setText
      // resets cursor to end). Instead, the sync effect below re-applies
      // cursorOverride after MultilineInput's value sync has run.
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

      // On an empty input, up-arrow enters the inline queue selector at the
      // bottom item. Further up-arrows walk into ordinary input history.
      if (direction === 'up' && value === '' && pendingQueuedMessages && pendingQueuedMessages.length > 0) {
        setQueueNotice(null);
        queueSelectionJustOpenedRef.current = true;
        updateQueueSelection(pendingQueuedMessages.length - 1);
        return;
      }

      // In text mode, arrows traverse input history.
      const next = direction === 'up' ? navigateUp({ text: value, images }) : navigateDown();
      if (next !== null) {
        onChange(next.text);
        suppressImagesCallbackRef.current = true;
        setImages((prevImages) => (areImagesEqual(prevImages, next.images ?? []) ? prevImages : next.images ?? []));
        remountInput();
      }
    },
    [
      mode,
      modeHandlers,
      navigateUp,
      navigateDown,
      value,
      images,
      onChange,
      remountInput,
      setImages,
      pendingQueuedMessages,
      updateQueueSelection,
    ],
  );

  const handleWrapperSubmit = useCallback(
    (submittedValue: string, submittedImages?: ImageRef[], busyMode: 'steer' | 'follow_up' = 'steer') => {
      if (mode !== 'text' && modeHandlers[mode].onSubmit?.(submittedValue) === 'handled') return;
      const turnImages = submittedImages ?? images;
      if (!allowEmptySubmit && !submittedValue.trim() && turnImages.length === 0) return;
      if (editingQueueItem) {
        if (!onEditQueuedMessage) return;
        const editedItem = editingQueueItem;
        void onEditQueuedMessage(editedItem.id, {
          text: submittedValue,
          ...(turnImages.length ? { images: turnImages } : {}),
        }).then((result) => {
          setEditingQueueItem(null);
          if (result.kind === 'too_late') {
            setQueueNotice('already sent — the model has it');
            void onSubmit({ text: submittedValue, ...(turnImages.length ? { images: turnImages } : {}) }, { busyMode });
          } else if (result.kind === 'unknown_id') {
            setQueueNotice('queued message is no longer available');
          }
        });
        return;
      }
      setImages([]);
      void onSubmit({ text: submittedValue, ...(turnImages.length ? { images: turnImages } : {}) }, { busyMode });
    },
    [mode, modeHandlers, onSubmit, images, allowEmptySubmit, setImages, editingQueueItem, onEditQueuedMessage],
  );

  useEffect(() => {
    if (!stdin || mode !== 'text') return;

    const onData = (chunk: Buffer | string) => {
      const value = String(chunk);
      const isRecentEscape = Date.now() - stdinBufferTimestampRef.current < 100;
      if (value === '\x1b\r' || (stdinBufferRef.current === '\x1b' && value === '\r' && isRecentEscape)) {
        consumedAltEnterRef.current = true;
        handleWrapperSubmit(inputValueRef.current, images, 'follow_up');
      }
      if (value.endsWith('\x1b')) {
        stdinBufferRef.current = '\x1b';
        stdinBufferTimestampRef.current = Date.now();
      } else {
        stdinBufferRef.current = '';
      }
    };
    stdin.prependListener('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin, mode, images, handleWrapperSubmit]);

  const handlePasteError = useCallback(
    (reason: PasteErrorReason) => {
      loggingService.warn('Image paste failed', { reason });
    },
    [loggingService],
  );

  // Wrap MultilineInput's onChange to strip terminal focus-reporting sequences
  // (\x1b[I = focus-in, \x1b[O = focus-out) that may arrive while the terminal
  // delivers DEC mode ?1004 events and MultilineInput doesn't recognise them.
  const handleMultilineChange = useCallback(
    (newValue: string) => {
      const filtered = newValue.replace(/\x1b\[I|\x1b\[O/g, '');
      onChange(filtered);
    },
    [onChange],
  );

  return (
    <Box flexDirection="column">
      {((pendingQueuedMessages?.length ?? 0) > 0 || queueNotice) && (
        <PendingQueueList
          messages={pendingQueuedMessages ?? []}
          selectedIndex={queueSelectionIndex}
          editingId={editingQueueItem?.id ?? null}
          notice={queueNotice}
        />
      )}
      <PopupManager
        {...toPopupProps({ slash, path, settings, settingsValue, models, skills, rewind, providers })}
        settingsService={settingsService}
      />

      {activePromptLabel && (
        <Box>
          <Text color="#22d3ee">{activePromptLabel}</Text>
        </Box>
      )}

      <Box>
        {!activePromptLabel && waitingForRejectionReason ? (
          <Text color="yellow">Why? </Text>
        ) : isShellMode ? (
          <Text color="green">$ </Text>
        ) : (
          <Text color="#22d3ee">❯ </Text>
        )}
        <MultilineInput
          key={inputKey}
          value={value}
          width={terminalWidth}
          isActive={mode === 'text' && queueSelectionIndex === null}
          onChange={handleMultilineChange}
          onSubmit={handleWrapperSubmit}
          onCursorChange={handleCursorChange}
          cursorOverride={cursorOverride ?? undefined}
          onBoundaryArrow={handleBoundaryArrow}
          enableImagePaste
          images={images}
          onImagesChange={handleImagesChange}
          onPasteError={handlePasteError}
          pasteThreshold={settingsService.get('ui.pasteThreshold')}
          ignoreInput={(input, key) => {
            if (consumedAltEnterRef.current && (input.includes('\x1b\r') || key.return)) {
              consumedAltEnterRef.current = false;
              return true;
            }
            return isFocusReportingSequence(input) || (key.meta && key.return);
          }}
        />
      </Box>
      {escHintVisible && <Text color="#64748b">Press ESC again to clear input</Text>}
      {waitingForRejectionReason && <Text color="#64748b">(or ESC to cancel)</Text>}
    </Box>
  );
};

export default React.memo(InputBox);
