'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useStoreSelector } from '../../../hooks/useStoreSelector';
import { extractAtMention } from '../../../lib/term2/composer-text';
import { filterFileMentions } from '../../../lib/term2/picker-filters';
import type { Composer as ComposerState } from '../../../lib/term2/shell-machine';
import { currentTag } from '../../../lib/term2/shell-machine';
import type { WorkspaceFileEntry } from '../../../lib/term2/types';
import { Term2PathPopover, Term2QuickPalette } from '../Term2ComposerPopovers';
import { ComposerAttachments } from './ComposerAttachments';
import { ComposerToolbar } from './ComposerToolbar';
import { useChatFacts, useShell, useShellState } from './ShellContext';
import { useQuickActions } from './useQuickActions';

/**
 * The message box: drop target, `@` file and slash popovers, the textarea and its keys, and the toolbar. Its text
 * lives in the shell machine; typing re-renders this component and nothing else. Memoised so a parent re-render
 * (a scroll that changes the pin) does not reach it.
 */
export const Composer = memo(function Composer() {
  const shell = useShell();
  const { dispatch, ops } = shell;
  const input = useShellState((s) => s.composer.input);
  const historyIndex = useShellState((s) => s.composer.historyIndex);
  const paletteOpen = useShellState((s) => s.composer.paletteOpen);
  const resendNotice = useShellState((s) => s.notices.resend);
  const composerDisabled = useChatFacts((f) => f.composerDisabled);
  const interactionPending = useChatFacts((f) => f.interactionPending);
  const hasStreamingTurn = useChatFacts((f) => f.hasStreamingTurn);
  const submitError = useChatFacts((f) => f.submitError);
  const fileScope = useChatFacts((f) => f.fileScope);
  const fileScopeKey = useChatFacts((f) => f.fileScopeKey);
  const files = useStoreSelector(shell.data.files, (s) => s);
  const promptHistory = useStoreSelector(shell.prefs, (p) => p.promptHistory);
  const [draggingFile, setDraggingFile] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const [popoverIndex, setPopoverIndex] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const savedDraftRef = useRef<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const skillPickedRef = useRef(false);

  // Dispatch synchronously in the event, as setState would, or the caret jumps.
  const editComposer = useCallback(
    (patch: Partial<ComposerState>) => dispatch({ type: 'COMPOSER_EDITED', patch }),
    [dispatch],
  );
  const setInput = useCallback(
    (next: string | ((current: string) => string)) =>
      editComposer({ input: typeof next === 'function' ? next(shell.store.get().composer.input) : next }),
    [editComposer, shell.store],
  );
  const setPaletteOpen = useCallback((open: boolean) => editComposer({ paletteOpen: open }), [editComposer]);

  // Other regions reach the message box through this handle (starter prompts, Cmd/Ctrl+K, focus after a pick).
  useEffect(() => {
    shell.composer.current = {
      focus: () => composerRef.current?.focus(),
      setText: (text) => {
        editComposer({ input: text });
        setCursorPos(text.length);
        composerRef.current?.focus();
      },
      togglePalette: () => {
        editComposer({ paletteOpen: !shell.store.get().composer.paletteOpen });
        setPopoverIndex(0);
        composerRef.current?.focus();
      },
    };
    return () => {
      shell.composer.current = null;
    };
  }, [shell, editComposer]);

  // Grow with the text, up to 240px. Only when the text changes, not on mount: an empty box keeps its CSS height.
  const sizedFor = useRef(input);
  useEffect(() => {
    const el = composerRef.current;
    if (!el || sizedFor.current === input) return;
    sizedFor.current = input;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [input]);

  // @ file mention detection
  const atMention = useMemo(() => extractAtMention(input, cursorPos), [input, cursorPos]);
  useEffect(() => {
    if (atMention && fileScope) shell.data.ensureFiles(fileScope);
  }, [atMention, fileScope, shell.data]);

  const matchingFiles = useMemo(() => {
    if (!atMention || files.key !== fileScopeKey || !files.loaded) return [];
    return filterFileMentions(files.data, atMention.query);
  }, [atMention, fileScopeKey, files]);

  const insertFileMention = (entry: WorkspaceFileEntry) => {
    if (!atMention) return;
    const suffix = entry.type === 'directory' ? '/' : ' ';
    const inserted = `@${entry.path}${suffix}`;
    const before = input.slice(0, atMention.start);
    const after = input.slice(cursorPos);
    const next = `${before}${inserted}${after}`;
    setInput(next);
    const nextCursor = before.length + inserted.length;
    setCursorPos(nextCursor);
    setPopoverIndex(0);
    window.setTimeout(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(nextCursor, nextCursor);
    }, 0);
  };

  // Slash / Cmd+K Quick Actions Palette
  const slashQuery =
    !atMention && input.startsWith('/') && !input.includes('\n') && !input.includes(' ') ? input.slice(1) : null;
  const showQuickPalette = paletteOpen || slashQuery !== null;
  const clearPalette = useCallback(() => {
    setPaletteOpen(false);
    if (slashQuery !== null) setInput('');
  }, [setPaletteOpen, setInput, slashQuery]);
  const quickActions = useQuickActions(slashQuery, clearPalette);

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      event.preventDefault();
      void ops.addImages(imageFiles);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingFile(false);
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      void ops.addImages(files);
    }
  };

  const onMentionFile = () => {
    const prefix = input && !input.endsWith(' ') ? `${input} @` : `${input}@`;
    setInput(prefix);
    setCursorPos(prefix.length);
    if (fileScope) shell.data.ensureFiles(fileScope);
    composerRef.current?.focus();
  };

  const handleAttachImage = useCallback(() => fileInputRef.current?.click(), []);
  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDraggingFile(true);
      }}
      onDragLeave={() => setDraggingFile(false)}
      onDrop={handleDrop}
      className={`pointer-events-auto relative mx-auto max-w-[46rem] overflow-visible rounded-3xl border bg-white shadow-[0_2px_6px_rgba(0,0,0,0.03),0_12px_32px_-12px_rgba(0,0,0,0.12)] transition-[border-color,box-shadow] focus-within:border-black/[0.16] focus-within:shadow-[0_2px_6px_rgba(0,0,0,0.04),0_16px_40px_-12px_rgba(0,0,0,0.18)] dark:bg-zinc-800/80 dark:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.6)] dark:focus-within:border-white/[0.18] ${
        draggingFile
          ? 'border-teal-500 ring-2 ring-teal-500/20'
          : 'border-black/[0.08] dark:border-white/[0.09]'
      }`}
    >
      {atMention && (
        <Term2PathPopover
          entries={matchingFiles}
          query={atMention.query}
          loading={files.loading}
          activeIndex={Math.min(popoverIndex, Math.max(0, matchingFiles.length - 1))}
          onSelect={insertFileMention}
        />
      )}
      {!atMention && showQuickPalette && (
        <Term2QuickPalette
          actions={quickActions}
          activeIndex={Math.min(popoverIndex, Math.max(0, quickActions.length - 1))}
          query={slashQuery ?? ''}
        />
      )}

      <ComposerAttachments />

      <textarea
        ref={composerRef}
        rows={1}
        aria-label="Message"
        value={input}
        onPaste={handlePaste}
        onChange={(event) => {
          setInput(event.target.value);
          setCursorPos(event.target.selectionStart ?? event.target.value.length);
          setPopoverIndex(0);
          editComposer({ historyIndex: null });
          if (submitError) shell.session.clearSubmitError();
          if (resendNotice)
            dispatch({ type: 'NOTICE', tag: currentTag(shell.store.get()), key: 'resend', message: null });
        }}
        onClick={(event) => setCursorPos(event.currentTarget.selectionStart ?? input.length)}
        onKeyUp={(event) => setCursorPos(event.currentTarget.selectionStart ?? input.length)}
        onKeyDown={(event) => {
          if (atMention && matchingFiles.length > 0) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setPopoverIndex((i) => (i + 1) % matchingFiles.length);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setPopoverIndex((i) => (i - 1 + matchingFiles.length) % matchingFiles.length);
              return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              insertFileMention(matchingFiles[Math.min(popoverIndex, matchingFiles.length - 1)]);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setInput((cur) => `${cur.slice(0, atMention.start)}${cur.slice(cursorPos)}`);
              return;
            }
          }
          if (showQuickPalette) {
            if (event.key === 'Escape') {
              event.preventDefault();
              setPaletteOpen(false);
              if (slashQuery !== null) setInput('');
              return;
            }
            if (quickActions.length > 0) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setPopoverIndex((i) => (i + 1) % quickActions.length);
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setPopoverIndex((i) => (i - 1 + quickActions.length) % quickActions.length);
                return;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                const chosen = quickActions[Math.min(popoverIndex, quickActions.length - 1)];
                if (chosen && !chosen.disabled) chosen.run();
                return;
              }
            }
          }
          if (
            event.key === 'ArrowUp' &&
            !event.shiftKey &&
            !input.includes('\n') &&
            (event.currentTarget.selectionStart ?? 0) === 0 &&
            promptHistory.length > 0
          ) {
            event.preventDefault();
            const nextIdx = historyIndex === null ? promptHistory.length - 1 : Math.max(0, historyIndex - 1);
            if (historyIndex === null) savedDraftRef.current = input;
            editComposer({ historyIndex: nextIdx });
            setInput(promptHistory[nextIdx]);
            return;
          }
          if (event.key === 'ArrowDown' && historyIndex !== null && !input.includes('\n')) {
            event.preventDefault();
            if (historyIndex >= promptHistory.length - 1) {
              editComposer({ historyIndex: null });
              setInput(savedDraftRef.current);
            } else {
              const nextIdx = historyIndex + 1;
              editComposer({ historyIndex: nextIdx });
              setInput(promptHistory[nextIdx]);
            }
            return;
          }
          if (event.key === 'Enter' && event.altKey && !event.nativeEvent.isComposing && hasStreamingTurn) {
            event.preventDefault();
            void ops.send('follow_up');
            return;
          }
          // Enter confirms an IME candidate; it must not send.
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void ops.send();
          }
        }}
        disabled={composerDisabled}
        className="block max-h-60 min-h-[52px] w-full resize-none bg-transparent px-5 pb-1 pt-4 text-base leading-6 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed dark:placeholder:text-zinc-500"
        placeholder={
          interactionPending
            ? 'Respond to the approval prompt above to continue…'
            : hasStreamingTurn
            ? 'Steer (Enter) or queue follow-up (Alt+Enter)…'
            : 'Ask about your files… (@ files, / actions)'
        }
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files) void ops.addImages(event.target.files);
          event.target.value = '';
        }}
      />
      <ComposerToolbar
        composerRef={composerRef}
        skillPickedRef={skillPickedRef}
        onAttachImage={handleAttachImage}
        onMentionFile={onMentionFile}
      />
    </div>
  );
});
