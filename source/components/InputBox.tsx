import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { MultilineInput } from 'ink-prompt';
import type { ImageRef, PasteErrorReason } from 'ink-prompt';
import { useEscapeKey } from '../hooks/use-escape-key.js';
import { useInputContext } from '../context/InputContext.js';
import { useInputHistory } from '../hooks/use-input-history.js';
import { useTerminalWidth } from '../hooks/use-terminal-width.js';
import type { SlashCommand } from '../slash-commands.js';
import type { SkillsService } from '../services/skills/skills-service.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import type { LoggingService } from '../services/logging/logging-service.js';
import type { HistoryService } from '../services/history-service.js';
import type { UserTurn } from '../types/user-turn.js';
import type { SubmissionMutation } from '../services/conversation/conversation-adapter.js';
import { MenuFooter, type MenuHint } from './common/MenuContainer.js';
import PendingQueueList, { orderPendingQueueMessages, type PendingQueueMessage } from './input/PendingQueueList.js';
import { useTheme } from './theme.js';
import { useSkin } from '../skins/SkinContext.js';

type Props = {
  onSubmit: (value: UserTurn, options?: { busyMode?: 'steer' | 'follow_up' }) => void | Promise<void>;
  onRejectionReasonInputReady?: () => void;
  /** @deprecated Menu commands are consumed by ApplicationInputSurface. */
  slashCommands?: SlashCommand[];
  /** @deprecated Menu sessions are mounted by ApplicationInputSurface. */
  skillsService?: SkillsService;
  waitingForRejectionReason?: boolean;
  turnInFlight?: boolean;
  isShellMode?: boolean;
  onShellModeEnter?: () => void;
  onShellModeExit?: () => void;
  settingsService: SettingsService;
  loggingService: LoggingService;
  historyService: HistoryService;
  onSettingChange?: (key: string, value: any) => void;
  onSystemMessage?: (text: string) => void;
  promptLabel?: string;
  allowEmptySubmit?: boolean;
  pendingQueuedMessages?: ReadonlyArray<PendingQueueMessage>;
  onRetractQueuedMessage?: (id: string) => Promise<SubmissionMutation>;
  onEditQueuedMessage?: (id: string, turn: UserTurn) => Promise<SubmissionMutation>;
  cursorOverride?: number | null;
  historyNavigation?: ReturnType<typeof useInputHistory>;
};

const areImagesEqual = (a: ImageRef[], b: ImageRef[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((image, index) => {
    const other = b[index];
    return Boolean(
      other &&
        image.id === other.id &&
        image.data === other.data &&
        image.mimeType === other.mimeType &&
        image.byteSize === other.byteSize &&
        image.displayNumber === other.displayNumber,
    );
  });
};

const isFocusReportingSequence = (input: string): boolean =>
  input === '\x1b[I' || input === '\x1b[O' || input === '[I' || input === '[O';

const MODEL_HINTS: ReadonlyArray<MenuHint> = [
  ['Ctrl+O', 'model'],
  ['Ctrl+T', 'effort'],
];

export const getImagePasteErrorMessage = (reason: PasteErrorReason): string => {
  const message =
    reason === 'clipboard-empty'
      ? 'No image found in clipboard'
      : reason === 'clipboard-unsupported-type'
      ? 'Clipboard image format is unsupported'
      : reason === 'image-too-large'
      ? 'Clipboard image is too large'
      : reason === 'too-many-images'
      ? 'Too many images in clipboard'
      : 'Could not read clipboard image';
  return `${message} — try copying the image again or paste it as a file path`;
};

const IDLE_HINTS: ReadonlyArray<MenuHint> = [
  ['/', 'commands'],
  ['@', 'paths'],
  ['!', 'shell'],
  ['Shift+Tab', 'plan'],
];

// Steer/queue key colors match the pending-queue group headers they create.
const TURN_IN_FLIGHT_HINTS: ReadonlyArray<MenuHint> = [
  ['⏎', 'steer', 'accent'],
  ['Alt+⏎', 'queue', 'accentAlt'],
  ...MODEL_HINTS,
];

const InputBox: FC<Props> = ({
  onSubmit,
  onRejectionReasonInputReady,
  settingsService,
  loggingService,
  waitingForRejectionReason = false,
  turnInFlight = false,
  isShellMode = false,
  onShellModeEnter,
  onShellModeExit,
  onSystemMessage,
  historyService,
  promptLabel,
  allowEmptySubmit = false,
  pendingQueuedMessages: unorderedPendingQueuedMessages,
  onRetractQueuedMessage,
  onEditQueuedMessage,
  cursorOverride: propsCursorOverride,
  historyNavigation,
}) => {
  const theme = useTheme();
  const { PromptMarker, InputFrame } = useSkin();
  const {
    input: value,
    setInput: onChange,
    cursorOffset,
    setCursorOffset,
    images,
    setImages,
    cursorOverride: contextCursorOverride,
    setCursorOverride,
    controller,
    queueInput,
    setQueueInput,
  } = useInputContext();
  const cursorOverride = propsCursorOverride ?? contextCursorOverride;
  // Selection indexes into the grouped display order, not arrival order.
  const pendingQueuedMessages = useMemo(
    () => unorderedPendingQueuedMessages && orderPendingQueueMessages(unorderedPendingQueuedMessages),
    [unorderedPendingQueuedMessages],
  );
  const { stdin } = useStdin();
  const inputValueRef = useRef(value);
  const imagesRef = useRef(images);
  const cursorOffsetRef = useRef(cursorOffset);
  // ink-prompt first emits its empty local image state before synchronizing
  // controlled attachments. A menu/modal remount must not clear the draft.
  const suppressImagesCallbackRef = useRef(true);
  const stdinBufferRef = useRef('');
  const stdinBufferTimestampRef = useRef(0);
  const consumedAltEnterRef = useRef(false);
  const queueSaveConsumedRef = useRef(false);
  const altEnterSuppressUntilRef = useRef(0);

  inputValueRef.current = value;
  imagesRef.current = images;
  cursorOffsetRef.current = cursorOffset;

  const [inputKey, setInputKey] = useState(0);
  // Answers, rejection reasons, shell commands and handoff prompts reuse this
  // component, but they are different composer purposes, not queued edits.
  const queueInteractionEnabled = !waitingForRejectionReason && !promptLabel && !isShellMode;
  const queueSelectionIndex = queueInteractionEnabled ? queueInput.selectionIndex : null;
  const editingQueueItem = queueInteractionEnabled ? queueInput.editing : null;
  const queueNotice = queueInteractionEnabled ? queueInput.notice : null;
  const editingQueueItemRef = useRef<typeof editingQueueItem>(null);
  const setEditingQueueItem = useCallback(
    (editing: typeof editingQueueItem) => {
      editingQueueItemRef.current = editing;
      setQueueInput((previous) => ({ ...previous, editing }));
    },
    [setQueueInput],
  );
  const setQueueNotice = useCallback(
    (notice: string | null) => setQueueInput((previous) => ({ ...previous, notice })),
    [setQueueInput],
  );
  const queueSelectionIndexRef = useRef<number | null>(null);
  const queueSelectionJustOpenedRef = useRef(false);
  const pendingQueuedMessagesRef = useRef<ReadonlyArray<PendingQueueMessage>>(pendingQueuedMessages ?? []);
  queueSelectionIndexRef.current = queueSelectionIndex;
  editingQueueItemRef.current = editingQueueItem;
  pendingQueuedMessagesRef.current = pendingQueuedMessages ?? [];

  const updateQueueSelection = useCallback(
    (next: number | null) => {
      queueSelectionIndexRef.current = next;
      setQueueInput((previous) => ({ ...previous, selectionIndex: next }));
    },
    [setQueueInput],
  );

  const editingQueueDelivery = editingQueueItem
    ? pendingQueuedMessages?.find((message) => message.id === editingQueueItem.id)?.delivery
    : undefined;
  const activePromptLabel = editingQueueItem
    ? `edit ${editingQueueDelivery === 'steer' ? 'steer' : 'queued'} ▸ `
    : promptLabel;
  const terminalWidth = useTerminalWidth({ waitingForRejectionReason, isShellMode, promptLabel: activePromptLabel });
  const localHistoryNavigation = useInputHistory(historyService);
  const { navigateUp, navigateDown, reset: resetHistory } = historyNavigation ?? localHistoryNavigation;
  const remountInput = useCallback(() => setInputKey((previous) => previous + 1), []);

  useEffect(() => {
    if (queueInteractionEnabled) return;
    if (queueInput.editing) {
      suppressImagesCallbackRef.current = true;
      setImages([]);
    }
    setQueueInput((previous) =>
      previous.editing || previous.selectionIndex !== null || previous.notice
        ? { selectionIndex: null, editing: null, notice: null }
        : previous,
    );
  }, [queueInteractionEnabled, queueInput.editing, setImages, setQueueInput]);

  useEffect(() => {
    if (waitingForRejectionReason) onRejectionReasonInputReady?.();
  }, [onRejectionReasonInputReady, waitingForRejectionReason]);

  const handleCursorChange = useCallback(
    (nextOffset: number) => {
      if (
        propsCursorOverride !== undefined &&
        propsCursorOverride !== null &&
        contextCursorOverride !== null &&
        nextOffset !== cursorOffset
      ) {
        return;
      }
      cursorOffsetRef.current = nextOffset;
      setCursorOffset(nextOffset);
    },
    [contextCursorOverride, cursorOffset, propsCursorOverride, setCursorOffset],
  );

  const handleImagesChange = useCallback(
    (nextImages: ImageRef[]) => {
      if (queueSelectionIndexRef.current !== null) return;
      if (suppressImagesCallbackRef.current) {
        suppressImagesCallbackRef.current = false;
        return;
      }
      setImages((previous) => (areImagesEqual(previous, nextImages) ? previous : nextImages));
    },
    [setImages],
  );

  const cancelQueueInteraction = useCallback((): boolean => {
    if (queueSelectionIndexRef.current !== null) {
      updateQueueSelection(null);
      return true;
    }
    if (editingQueueItemRef.current) {
      const { restoreDraft, restoreCursor } = editingQueueItemRef.current;
      onChange(restoreDraft.text);
      suppressImagesCallbackRef.current = true;
      remountInput();
      setImages(restoreDraft.images ?? []);
      setCursorOffset(restoreCursor);
      setCursorOverride(restoreCursor);
      setEditingQueueItem(null);
      return true;
    }
    return false;
  }, [
    onChange,
    remountInput,
    setImages,
    setCursorOffset,
    setCursorOverride,
    setEditingQueueItem,
    updateQueueSelection,
  ]);

  const handleEscape = useCallback((): boolean => {
    if (controller.getSnapshot().stack.length > 0) {
      controller.escape();
      setCursorOverride(controller.getSnapshot().editor.cursor);
      return true;
    }
    if (isShellMode && inputValueRef.current === '') {
      onShellModeExit?.();
      return true;
    }
    return cancelQueueInteraction();
  }, [cancelQueueInteraction, controller, isShellMode, onShellModeExit, setCursorOverride]);

  const { escHintVisible } = useEscapeKey({
    value,
    onChange: (nextValue) => {
      resetHistory();
      onChange(nextValue);
    },
    onEscape: handleEscape,
    turnInFlight,
  });

  useInput((_input, key) => {
    const selectedQueueIndex = queueSelectionIndexRef.current;
    const currentQueuedMessages = pendingQueuedMessagesRef.current;
    if (selectedQueueIndex === null) return;
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
      } else {
        updateQueueSelection(null);
        const previous = navigateUp({ text: inputValueRef.current, images });
        if (previous !== null) {
          onChange(previous.text);
          suppressImagesCallbackRef.current = true;
          setImages((previousImages) =>
            areImagesEqual(previousImages, previous.images ?? []) ? previousImages : previous.images ?? [],
          );
          remountInput();
        }
      }
      return;
    }
    if (key.downArrow) {
      updateQueueSelection(selectedQueueIndex < currentQueuedMessages.length - 1 ? selectedQueueIndex + 1 : null);
      return;
    }
    if (_input === 'e' || key.return) {
      setQueueNotice(null);
      const turn = selectedMessage.turn;
      setEditingQueueItem({
        id: selectedMessage.id,
        turn,
        restoreDraft: { text: inputValueRef.current, images: imagesRef.current },
        restoreCursor: cursorOffsetRef.current,
      });
      updateQueueSelection(null);
      onChange(turn.text);
      setImages(turn.images ?? []);
      setCursorOffset(turn.text.length);
      setCursorOverride(turn.text.length);
      return;
    }
    if (_input === 'd' && onRetractQueuedMessage) {
      void onRetractQueuedMessage(selectedMessage.id).then((result) => {
        updateQueueSelection(null);
        if (result.kind === 'too_late') setQueueNotice('already sent — the model has it');
        else if (result.kind === 'unknown_id') setQueueNotice('queued message is no longer available');
      });
    }
  });

  const handleBoundaryArrow = useCallback(
    (direction: 'up' | 'down' | 'left' | 'right') => {
      if (!queueInteractionEnabled) return;
      if (direction !== 'up' && direction !== 'down') return;
      if (direction === 'up' && value === '' && pendingQueuedMessages && pendingQueuedMessages.length > 0) {
        setQueueNotice(null);
        queueSelectionJustOpenedRef.current = true;
        queueMicrotask(() => {
          queueSelectionJustOpenedRef.current = false;
        });
        updateQueueSelection(pendingQueuedMessages.length - 1);
        return;
      }
      const next = direction === 'up' ? navigateUp({ text: value, images }) : navigateDown();
      if (next !== null) {
        onChange(next.text);
        suppressImagesCallbackRef.current = true;
        setImages((previous) => (areImagesEqual(previous, next.images ?? []) ? previous : next.images ?? []));
        remountInput();
      }
    },
    [
      images,
      navigateDown,
      navigateUp,
      onChange,
      pendingQueuedMessages,
      queueInteractionEnabled,
      remountInput,
      setImages,
      setQueueNotice,
      updateQueueSelection,
      value,
    ],
  );

  useEffect(() => {
    // Rearm only after the controlled draft has synchronized. Two Enter events
    // in one input burst otherwise reuse ink-prompt's pre-submit text/images.
    queueSaveConsumedRef.current = false;
  }, [value, images]);

  const handleWrapperSubmit = useCallback(
    (submittedValue: string, submittedImages?: ImageRef[], busyMode: 'steer' | 'follow_up' = 'steer') => {
      if (queueSaveConsumedRef.current) return;
      if (busyMode === 'steer' && Date.now() < altEnterSuppressUntilRef.current) {
        altEnterSuppressUntilRef.current = 0;
        consumedAltEnterRef.current = false;
        return;
      }
      const turnImages = submittedImages ?? images;
      if (!allowEmptySubmit && !submittedValue.trim() && turnImages.length === 0) return;
      if (queueInteractionEnabled && editingQueueItemRef.current) {
        if (!onEditQueuedMessage) return;
        const editedItem = editingQueueItemRef.current;
        const editedTurn: UserTurn = {
          text: submittedValue,
          ...(turnImages.length ? { images: turnImages } : {}),
          ...(editedItem.turn.skill ? { skill: editedItem.turn.skill } : {}),
        };
        // Enter finishes this editing interaction synchronously. The mutation
        // can resolve after another draft, queued edit, or modal has taken over;
        // its completion must never restore an old composer snapshot.
        queueSaveConsumedRef.current = true;
        setEditingQueueItem(null);
        resetHistory();
        setImages(editedItem.restoreDraft.images ?? []);
        void onEditQueuedMessage(editedItem.id, editedTurn)
          .then((result) => {
            if (result.kind === 'too_late') {
              setQueueNotice('already sent — the model has it');
              void onSubmit(editedTurn, { busyMode });
            } else if (result.kind === 'unknown_id') {
              setQueueNotice('queued message is no longer available');
            }
          })
          .catch((error: unknown) => {
            loggingService.warn('Queued message edit failed', { error });
            setQueueNotice('could not save queued edit — select the queued message to retry');
          });
        return;
      }
      resetHistory();
      setImages([]);
      void onSubmit({ text: submittedValue, ...(turnImages.length ? { images: turnImages } : {}) }, { busyMode });
    },
    [
      allowEmptySubmit,
      queueInteractionEnabled,
      images,
      loggingService,
      onEditQueuedMessage,
      onSubmit,
      resetHistory,
      setImages,
      setEditingQueueItem,
      setQueueNotice,
    ],
  );

  useEffect(() => {
    if (!stdin) return;
    const onData = (chunk: Buffer | string) => {
      const data = String(chunk);
      if (isShellMode && inputValueRef.current === '' && (data === '\x7f' || data === '\b')) {
        onShellModeExit?.();
      }
      const isRecentEscape = Date.now() - stdinBufferTimestampRef.current < 100;
      if (data === '\x1b\r' || (stdinBufferRef.current === '\x1b' && data === '\r' && isRecentEscape)) {
        consumedAltEnterRef.current = true;
        altEnterSuppressUntilRef.current = Date.now() + 100;
        handleWrapperSubmit(inputValueRef.current, images, 'follow_up');
      }
      if (data.endsWith('\x1b')) {
        consumedAltEnterRef.current = true;
        stdinBufferRef.current = '\x1b';
        stdinBufferTimestampRef.current = Date.now();
        altEnterSuppressUntilRef.current = Date.now() + 100;
      } else {
        stdinBufferRef.current = '';
      }
    };
    stdin.prependListener('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [handleWrapperSubmit, images, isShellMode, onShellModeExit, stdin]);

  useEffect(() => {
    if (cursorOverride !== null && cursorOverride === cursorOffset) {
      setCursorOverride(null);
    }
  }, [cursorOffset, cursorOverride, setCursorOverride]);

  const handlePasteError = useCallback(
    (reason: PasteErrorReason) => {
      loggingService.warn('Image paste failed', { reason });
      onSystemMessage?.(getImagePasteErrorMessage(reason));
    },
    [loggingService, onSystemMessage],
  );
  const handleMultilineChange = useCallback(
    (newValue: string) => {
      const filtered = newValue.replace(/\x1b\[I|\x1b\[O/g, '');
      if (!isShellMode && inputValueRef.current === '' && filtered.startsWith('!')) {
        onChange(filtered.slice(1));
        remountInput();
        onShellModeEnter?.();
        return;
      }
      // ink-prompt can echo the controlled value when it mounts. Treat that
      // as synchronization, not an edit, so it cannot move a middle cursor
      // to the end during the menu-to-editor handoff.
      if (filtered !== inputValueRef.current) onChange(filtered);
    },
    [isShellMode, onChange, onShellModeEnter, remountInput],
  );

  return (
    <Box flexDirection="column">
      {queueInteractionEnabled && ((pendingQueuedMessages?.length ?? 0) > 0 || queueNotice) && (
        <PendingQueueList
          messages={pendingQueuedMessages ?? []}
          selectedIndex={queueSelectionIndex}
          editingId={editingQueueItem?.id ?? null}
          notice={queueNotice}
        />
      )}
      {activePromptLabel && (
        <Box>
          <Text color={theme.accent}>{activePromptLabel}</Text>
        </Box>
      )}
      <InputFrame>
        <PromptMarker
          mode={!activePromptLabel && waitingForRejectionReason ? 'rejection' : isShellMode ? 'shell' : 'input'}
        />
        <MultilineInput
          key={inputKey}
          value={value}
          width={terminalWidth}
          isActive={queueSelectionIndex === null}
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
          formatPastePlaceholder={(displayNumber, pastedText) => {
            const lineCount = pastedText.split(/\r\n|\r|\n/).length - (/(?:\r\n|\r|\n)$/.test(pastedText) ? 1 : 0);
            return `[Paste text #${displayNumber} · ${lineCount} lines]`;
          }}
          ignoreInput={(input, key) => {
            if (Date.now() >= altEnterSuppressUntilRef.current) consumedAltEnterRef.current = false;
            if (consumedAltEnterRef.current && (input.includes('\x1b\r') || key.return)) {
              consumedAltEnterRef.current = false;
              altEnterSuppressUntilRef.current = 0;
              return true;
            }
            if (isShellMode && value === '' && (key.backspace || input === '\x7f' || input === '\b')) return true;
            return isFocusReportingSequence(input) || (key.meta && key.return);
          }}
        />
      </InputFrame>
      {escHintVisible && <Text color={theme.textSubtle}>Press Esc again to clear input</Text>}
      {waitingForRejectionReason && <Text color={theme.textSubtle}>(or Esc to cancel)</Text>}
      {!turnInFlight &&
        !waitingForRejectionReason &&
        !escHintVisible &&
        queueSelectionIndex === null &&
        value === '' &&
        !activePromptLabel && <MenuFooter hints={IDLE_HINTS} />}
      {turnInFlight && queueSelectionIndex === null && !waitingForRejectionReason && !escHintVisible && (
        <MenuFooter
          hints={
            (pendingQueuedMessages?.length ?? 0) > 0 && value === ''
              ? [['↑', 'select queued'], ...TURN_IN_FLIGHT_HINTS]
              : TURN_IN_FLIGHT_HINTS
          }
        />
      )}
    </Box>
  );
};

export default React.memo(InputBox);
