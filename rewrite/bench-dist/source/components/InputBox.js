import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { MultilineInput } from 'ink-prompt';
import { useEscapeKey } from '../hooks/use-escape-key.js';
import { useInputContext } from '../context/InputContext.js';
import { useInputHistory } from '../hooks/use-input-history.js';
import { useTerminalWidth } from '../hooks/use-terminal-width.js';
import { MenuFooter } from './common/MenuContainer.js';
import PendingQueueList, { orderPendingQueueMessages } from './input/PendingQueueList.js';
import { useTheme } from './theme.js';
import { useSkin } from '../skins/SkinContext.js';
const areImagesEqual = (a, b) => {
    if (a === b)
        return true;
    if (a.length !== b.length)
        return false;
    return a.every((image, index) => {
        const other = b[index];
        return Boolean(other &&
            image.id === other.id &&
            image.data === other.data &&
            image.mimeType === other.mimeType &&
            image.byteSize === other.byteSize &&
            image.displayNumber === other.displayNumber);
    });
};
const isFocusReportingSequence = (input) => input === '\x1b[I' || input === '\x1b[O' || input === '[I' || input === '[O';
const MODEL_HINTS = [
    ['Ctrl+O', 'model'],
    ['Ctrl+T', 'effort'],
];
export const getImagePasteErrorMessage = (reason) => {
    const message = reason === 'clipboard-empty'
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
const IDLE_HINTS = [
    ['/', 'commands'],
    ['@', 'paths'],
    ['!', 'shell'],
    ['Shift+Tab', 'plan'],
];
// Steer/queue key colors match the pending-queue group headers they create.
const TURN_IN_FLIGHT_HINTS = [
    ['⏎', 'steer', 'accent'],
    ['Alt+⏎', 'queue', 'accentAlt'],
    ...MODEL_HINTS,
];
const InputBox = ({ onSubmit, onRejectionReasonInputReady, settingsService, loggingService, waitingForRejectionReason = false, turnInFlight = false, isShellMode = false, onShellModeEnter, onShellModeExit, onSystemMessage, historyService, promptLabel, allowEmptySubmit = false, pendingQueuedMessages: unorderedPendingQueuedMessages, onRetractQueuedMessage, onEditQueuedMessage, cursorOverride: propsCursorOverride, historyNavigation, }) => {
    const theme = useTheme();
    const { PromptMarker, InputFrame } = useSkin();
    const { input: value, setInput: onChange, cursorOffset, setCursorOffset, images, setImages, cursorOverride: contextCursorOverride, setCursorOverride, controller, queueInput, setQueueInput, } = useInputContext();
    const cursorOverride = propsCursorOverride ?? contextCursorOverride;
    // Selection indexes into the grouped display order, not arrival order.
    const pendingQueuedMessages = useMemo(() => unorderedPendingQueuedMessages && orderPendingQueueMessages(unorderedPendingQueuedMessages), [unorderedPendingQueuedMessages]);
    const { stdin } = useStdin();
    const inputValueRef = useRef(value);
    const turnInFlightRef = useRef(turnInFlight);
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
    turnInFlightRef.current = turnInFlight;
    imagesRef.current = images;
    cursorOffsetRef.current = cursorOffset;
    const [inputKey, setInputKey] = useState(0);
    // Answers, rejection reasons, shell commands and handoff prompts reuse this
    // component, but they are different composer purposes, not queued edits.
    const queueInteractionEnabled = !waitingForRejectionReason && !promptLabel && !isShellMode;
    const queueSelectionIndex = queueInteractionEnabled ? queueInput.selectionIndex : null;
    const editingQueueItem = queueInteractionEnabled ? queueInput.editing : null;
    const queueNotice = queueInteractionEnabled ? queueInput.notice : null;
    const editingQueueItemRef = useRef(null);
    const setEditingQueueItem = useCallback((editing) => {
        editingQueueItemRef.current = editing;
        setQueueInput((previous) => ({ ...previous, editing }));
    }, [setQueueInput]);
    const setQueueNotice = useCallback((notice) => setQueueInput((previous) => ({ ...previous, notice })), [setQueueInput]);
    const queueSelectionIndexRef = useRef(null);
    const queueSelectionJustOpenedRef = useRef(false);
    const pendingQueuedMessagesRef = useRef(pendingQueuedMessages ?? []);
    queueSelectionIndexRef.current = queueSelectionIndex;
    editingQueueItemRef.current = editingQueueItem;
    pendingQueuedMessagesRef.current = pendingQueuedMessages ?? [];
    const updateQueueSelection = useCallback((next) => {
        queueSelectionIndexRef.current = next;
        setQueueInput((previous) => ({ ...previous, selectionIndex: next }));
    }, [setQueueInput]);
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
        if (queueInteractionEnabled)
            return;
        if (queueInput.editing) {
            suppressImagesCallbackRef.current = true;
            setImages([]);
        }
        setQueueInput((previous) => previous.editing || previous.selectionIndex !== null || previous.notice
            ? { selectionIndex: null, editing: null, notice: null }
            : previous);
    }, [queueInteractionEnabled, queueInput.editing, setImages, setQueueInput]);
    useEffect(() => {
        if (waitingForRejectionReason)
            onRejectionReasonInputReady?.();
    }, [onRejectionReasonInputReady, waitingForRejectionReason]);
    const handleCursorChange = useCallback((nextOffset) => {
        if (propsCursorOverride !== undefined &&
            propsCursorOverride !== null &&
            contextCursorOverride !== null &&
            nextOffset !== cursorOffset) {
            return;
        }
        cursorOffsetRef.current = nextOffset;
        setCursorOffset(nextOffset);
    }, [contextCursorOverride, cursorOffset, propsCursorOverride, setCursorOffset]);
    const handleImagesChange = useCallback((nextImages) => {
        if (queueSelectionIndexRef.current !== null)
            return;
        if (suppressImagesCallbackRef.current) {
            suppressImagesCallbackRef.current = false;
            return;
        }
        setImages((previous) => (areImagesEqual(previous, nextImages) ? previous : nextImages));
    }, [setImages]);
    const cancelQueueInteraction = useCallback(() => {
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
    const handleEscape = useCallback(() => {
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
        if (selectedQueueIndex === null)
            return;
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
            }
            else {
                updateQueueSelection(null);
                const previous = navigateUp({ text: inputValueRef.current, images });
                if (previous !== null) {
                    onChange(previous.text);
                    suppressImagesCallbackRef.current = true;
                    setImages((previousImages) => areImagesEqual(previousImages, previous.images ?? []) ? previousImages : previous.images ?? []);
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
                if (result.kind === 'too_late')
                    setQueueNotice('already sent — the model has it');
                else if (result.kind === 'unknown_id')
                    setQueueNotice('queued message is no longer available');
            });
        }
    });
    const handleBoundaryArrow = useCallback((direction) => {
        if (!queueInteractionEnabled)
            return;
        if (direction !== 'up' && direction !== 'down')
            return;
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
    }, [
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
    ]);
    useEffect(() => {
        // Rearm only after the controlled draft has synchronized. Two Enter events
        // in one input burst otherwise reuse ink-prompt's pre-submit text/images.
        queueSaveConsumedRef.current = false;
    }, [value, images]);
    const handleWrapperSubmit = useCallback((submittedValue, submittedImages, busyMode = 'steer') => {
        if (queueSaveConsumedRef.current)
            return;
        if (busyMode === 'steer' && Date.now() < altEnterSuppressUntilRef.current) {
            altEnterSuppressUntilRef.current = 0;
            consumedAltEnterRef.current = false;
            return;
        }
        const turnImages = submittedImages ?? images;
        if (!allowEmptySubmit && !submittedValue.trim() && turnImages.length === 0)
            return;
        if (queueInteractionEnabled && editingQueueItemRef.current) {
            if (!onEditQueuedMessage)
                return;
            const editedItem = editingQueueItemRef.current;
            const editedTurn = {
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
                }
                else if (result.kind === 'unknown_id') {
                    setQueueNotice('queued message is no longer available');
                }
            })
                .catch((error) => {
                loggingService.warn('Queued message edit failed', { error });
                setQueueNotice('could not save queued edit — select the queued message to retry');
            });
            return;
        }
        resetHistory();
        setImages([]);
        void onSubmit({ text: submittedValue, ...(turnImages.length ? { images: turnImages } : {}) }, { busyMode });
    }, [
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
    ]);
    useEffect(() => {
        if (!stdin)
            return;
        const onData = (chunk) => {
            const data = String(chunk);
            if (isShellMode && inputValueRef.current === '' && (data === '\x7f' || data === '\b')) {
                onShellModeExit?.();
            }
            const isRecentEscape = Date.now() - stdinBufferTimestampRef.current < 100;
            // Alt+Enter queues a message only while a turn runs. Many terminals send
            // the same `\x1b\r` for Shift+Enter, so when idle leave it to ink-prompt,
            // which inserts a newline.
            const altEnterActive = turnInFlightRef.current;
            if (altEnterActive &&
                (data === '\x1b\r' || (stdinBufferRef.current === '\x1b' && data === '\r' && isRecentEscape))) {
                consumedAltEnterRef.current = true;
                altEnterSuppressUntilRef.current = Date.now() + 100;
                handleWrapperSubmit(inputValueRef.current, images, 'follow_up');
            }
            if (data.endsWith('\x1b')) {
                if (altEnterActive) {
                    consumedAltEnterRef.current = true;
                    altEnterSuppressUntilRef.current = Date.now() + 100;
                }
                stdinBufferRef.current = '\x1b';
                stdinBufferTimestampRef.current = Date.now();
            }
            else {
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
    const handlePasteError = useCallback((reason) => {
        loggingService.warn('Image paste failed', { reason });
        onSystemMessage?.(getImagePasteErrorMessage(reason));
    }, [loggingService, onSystemMessage]);
    const handleMultilineChange = useCallback((newValue) => {
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
        if (filtered !== inputValueRef.current)
            onChange(filtered);
    }, [isShellMode, onChange, onShellModeEnter, remountInput]);
    return (React.createElement(Box, { flexDirection: "column" },
        queueInteractionEnabled && ((pendingQueuedMessages?.length ?? 0) > 0 || queueNotice) && (React.createElement(PendingQueueList, { messages: pendingQueuedMessages ?? [], selectedIndex: queueSelectionIndex, editingId: editingQueueItem?.id ?? null, notice: queueNotice })),
        activePromptLabel && (React.createElement(Box, null,
            React.createElement(Text, { color: theme.accent }, activePromptLabel))),
        React.createElement(InputFrame, null,
            React.createElement(PromptMarker, { mode: !activePromptLabel && waitingForRejectionReason ? 'rejection' : isShellMode ? 'shell' : 'input' }),
            React.createElement(MultilineInput, { key: inputKey, value: value, width: terminalWidth, isActive: queueSelectionIndex === null, onChange: handleMultilineChange, onSubmit: handleWrapperSubmit, onCursorChange: handleCursorChange, cursorOverride: cursorOverride ?? undefined, onBoundaryArrow: handleBoundaryArrow, enableImagePaste: true, images: images, onImagesChange: handleImagesChange, onPasteError: handlePasteError, pasteThreshold: settingsService.get('ui.pasteThreshold'), formatPastePlaceholder: (displayNumber, pastedText) => {
                    const lineCount = pastedText.split(/\r\n|\r|\n/).length - (/(?:\r\n|\r|\n)$/.test(pastedText) ? 1 : 0);
                    return `[Paste text #${displayNumber} · ${lineCount} lines]`;
                }, ignoreInput: (input, key) => {
                    if (Date.now() >= altEnterSuppressUntilRef.current)
                        consumedAltEnterRef.current = false;
                    if (consumedAltEnterRef.current && (input.includes('\x1b\r') || key.return)) {
                        consumedAltEnterRef.current = false;
                        altEnterSuppressUntilRef.current = 0;
                        return true;
                    }
                    if (isShellMode && value === '' && (key.backspace || input === '\x7f' || input === '\b'))
                        return true;
                    return isFocusReportingSequence(input) || (key.meta && key.return);
                } })),
        escHintVisible && React.createElement(Text, { color: theme.textSubtle }, "Press Esc again to clear input"),
        waitingForRejectionReason && React.createElement(Text, { color: theme.textSubtle }, "(or Esc to cancel)"),
        !turnInFlight &&
            !waitingForRejectionReason &&
            !escHintVisible &&
            queueSelectionIndex === null &&
            value === '' &&
            !activePromptLabel && React.createElement(MenuFooter, { hints: IDLE_HINTS }),
        turnInFlight && queueSelectionIndex === null && !waitingForRejectionReason && !escHintVisible && (React.createElement(MenuFooter, { hints: (pendingQueuedMessages?.length ?? 0) > 0 && value === ''
                ? [['↑', 'select queued'], ...TURN_IN_FLIGHT_HINTS]
                : TURN_IN_FLIGHT_HINTS }))));
};
export default React.memo(InputBox);
//# sourceMappingURL=InputBox.js.map