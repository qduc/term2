import React, { FC, useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { MultilineInput } from 'ink-prompt';
import type { ImageRef, PasteErrorReason } from 'ink-prompt';
import { useEscapeKey } from '../hooks/use-escape-key.js';
import { useInputContext } from '../context/InputContext.js';
import { useInputHistory } from '../hooks/use-input-history.js';
import { useTerminalWidth } from '../hooks/use-terminal-width.js';
import { calculateInputWidth } from './input/input-width.js';
import type { SlashCommand } from '../slash-commands.js';
import type { SkillsService } from '../services/skills/skills-service.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import type { LoggingService } from '../services/logging/logging-service.js';
import type { HistoryService } from '../services/history-service.js';
import type { UserTurn } from '../types/user-turn.js';
import type { SubmissionMutation } from '../services/conversation/conversation-adapter.js';
import PendingQueueList, { type PendingQueueMessage } from './input/PendingQueueList.js';
import {
  COLOR_ACCENT,
  COLOR_ACCENT_ALT,
  COLOR_SUCCESS,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SUBTLE,
  COLOR_WARNING,
} from './theme.js';

export { calculateInputWidth };

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

const InputBox: FC<Props> = ({
  onSubmit,
  onRejectionReasonInputReady,
  settingsService,
  loggingService,
  waitingForRejectionReason = false,
  turnInFlight = false,
  isShellMode = false,
  historyService,
  promptLabel,
  allowEmptySubmit = false,
  pendingQueuedMessages,
  onRetractQueuedMessage,
  onEditQueuedMessage,
  cursorOverride: propsCursorOverride,
}) => {
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
  } = useInputContext();
  const cursorOverride = propsCursorOverride ?? contextCursorOverride;
  const { stdin } = useStdin();
  const inputValueRef = useRef(value);
  const cursorOffsetRef = useRef(cursorOffset);
  const suppressImagesCallbackRef = useRef(false);
  const stdinBufferRef = useRef('');
  const stdinBufferTimestampRef = useRef(0);
  const consumedAltEnterRef = useRef(false);
  const altEnterSuppressUntilRef = useRef(0);

  inputValueRef.current = value;
  cursorOffsetRef.current = cursorOffset;

  const [inputKey, setInputKey] = useState(0);
  const [queueSelectionIndex, setQueueSelectionIndex] = useState<number | null>(null);
  const [editingQueueItem, setEditingQueueItem] = useState<{ id: string; restoreInput: string } | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const queueSelectionIndexRef = useRef<number | null>(null);
  const queueSelectionJustOpenedRef = useRef(false);
  const editingQueueItemRef = useRef<{ id: string; restoreInput: string } | null>(null);
  const pendingQueuedMessagesRef = useRef<ReadonlyArray<PendingQueueMessage>>(pendingQueuedMessages ?? []);
  queueSelectionIndexRef.current = queueSelectionIndex;
  editingQueueItemRef.current = editingQueueItem;
  pendingQueuedMessagesRef.current = pendingQueuedMessages ?? [];

  const updateQueueSelection = useCallback((next: number | null) => {
    queueSelectionIndexRef.current = next;
    setQueueSelectionIndex(next);
  }, []);

  const editingQueueIndex = editingQueueItem
    ? pendingQueuedMessages?.findIndex((message) => message.id === editingQueueItem.id)
    : -1;
  const activePromptLabel = editingQueueItem ? `edit ${(editingQueueIndex ?? -1) + 1} ▸ ` : promptLabel;
  const terminalWidth = useTerminalWidth({ waitingForRejectionReason, isShellMode, promptLabel: activePromptLabel });
  const { navigateUp, navigateDown } = useInputHistory(historyService);
  const remountInput = useCallback(() => setInputKey((previous) => previous + 1), []);

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
      onChange(editingQueueItemRef.current.restoreInput);
      setEditingQueueItem(null);
      return true;
    }
    return false;
  }, [onChange, updateQueueSelection]);

  const handleEscape = useCallback((): boolean => {
    if (controller.getSnapshot().stack.length > 0) {
      controller.escape();
      setCursorOverride(controller.getSnapshot().editor.cursor);
      return true;
    }
    return cancelQueueInteraction();
  }, [cancelQueueInteraction, controller, setCursorOverride]);

  const { escHintVisible } = useEscapeKey({
    value,
    onChange,
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
      setEditingQueueItem({ id: selectedMessage.id, restoreInput: inputValueRef.current });
      updateQueueSelection(null);
      onChange(selectedMessage.text);
      setCursorOffset(selectedMessage.text.length);
      setCursorOverride(selectedMessage.text.length);
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
      if (direction !== 'up' && direction !== 'down') return;
      if (direction === 'up' && value === '' && pendingQueuedMessages && pendingQueuedMessages.length > 0) {
        setQueueNotice(null);
        queueSelectionJustOpenedRef.current = true;
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
      remountInput,
      setImages,
      updateQueueSelection,
      value,
    ],
  );

  const handleWrapperSubmit = useCallback(
    (submittedValue: string, submittedImages?: ImageRef[], busyMode: 'steer' | 'follow_up' = 'steer') => {
      if (busyMode === 'steer' && Date.now() < altEnterSuppressUntilRef.current) {
        altEnterSuppressUntilRef.current = 0;
        consumedAltEnterRef.current = false;
        return;
      }
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
    [allowEmptySubmit, editingQueueItem, images, onEditQueuedMessage, onSubmit, setImages],
  );

  useEffect(() => {
    if (!stdin) return;
    const onData = (chunk: Buffer | string) => {
      const data = String(chunk);
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
  }, [handleWrapperSubmit, images, stdin]);

  useEffect(() => {
    if (cursorOverride !== null && cursorOverride === cursorOffset) {
      setCursorOverride(null);
    }
  }, [cursorOffset, cursorOverride, setCursorOverride]);

  const handlePasteError = useCallback(
    (reason: PasteErrorReason) => loggingService.warn('Image paste failed', { reason }),
    [loggingService],
  );
  const handleMultilineChange = useCallback(
    (newValue: string) => {
      const filtered = newValue.replace(/\x1b\[I|\x1b\[O/g, '');
      // ink-prompt can echo the controlled value when it mounts. Treat that
      // as synchronization, not an edit, so it cannot move a middle cursor
      // to the end during the menu-to-editor handoff.
      if (filtered !== inputValueRef.current) onChange(filtered);
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
      {activePromptLabel && (
        <Box>
          <Text color={COLOR_ACCENT}>{activePromptLabel}</Text>
        </Box>
      )}
      <Box>
        {!activePromptLabel && waitingForRejectionReason ? (
          <Text color={COLOR_WARNING}>Why? </Text>
        ) : isShellMode ? (
          <Text color={COLOR_SUCCESS}>$ </Text>
        ) : (
          <Text color={COLOR_ACCENT}>❯ </Text>
        )}
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
          ignoreInput={(input, key) => {
            if (Date.now() >= altEnterSuppressUntilRef.current) consumedAltEnterRef.current = false;
            if (consumedAltEnterRef.current && (input.includes('\x1b\r') || key.return)) {
              consumedAltEnterRef.current = false;
              altEnterSuppressUntilRef.current = 0;
              return true;
            }
            return isFocusReportingSequence(input) || (key.meta && key.return);
          }}
        />
      </Box>
      {escHintVisible && <Text color={COLOR_TEXT_SUBTLE}>Press ESC again to clear input</Text>}
      {waitingForRejectionReason && <Text color={COLOR_TEXT_SUBTLE}>(or ESC to cancel)</Text>}
      {!turnInFlight &&
        !waitingForRejectionReason &&
        !escHintVisible &&
        queueSelectionIndex === null &&
        value === '' &&
        !activePromptLabel && (
          <Box marginTop={0}>
            <Text color={COLOR_TEXT_SUBTLE}>
              <Text color={COLOR_TEXT_MUTED}>Ctrl+O</Text> model · <Text color={COLOR_TEXT_MUTED}>Ctrl+T</Text> effort
            </Text>
          </Box>
        )}
      {turnInFlight && queueSelectionIndex === null && !waitingForRejectionReason && !escHintVisible && (
        <Box marginTop={1}>
          <Text color={COLOR_TEXT_SUBTLE}>
            {(pendingQueuedMessages?.length ?? 0) > 0 && value === '' ? (
              <>
                <Text color={COLOR_TEXT_MUTED}>↑</Text> select queued · <Text color={COLOR_ACCENT}>Enter</Text> Steer ·{' '}
                <Text color={COLOR_ACCENT_ALT}>Alt+Enter</Text> Queue
              </>
            ) : (
              <>
                <Text color={COLOR_ACCENT}>Enter</Text> Steer active turn ·{' '}
                <Text color={COLOR_ACCENT_ALT}>Alt+Enter</Text> Queue for next turn
              </>
            )}
          </Text>
        </Box>
      )}
    </Box>
  );
};

export default React.memo(InputBox);
