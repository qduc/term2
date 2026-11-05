import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { MultilineInput, type ImageRef } from 'ink-prompt';
import type { TuiProps } from './integration.js';
import type { WireContent, WireEvent, WireSubmission } from '../../protocol/wire.js';
import { useTheme } from './presentation/components/theme.js';
import { useSkin } from './presentation/skins/SkinContext.js';
import { terminalPreferenceDefaults } from '../../host/terminal-preference-defaults.js';
import { useClient } from './use-client.js';
import { Activity, LiveNotices, interruptedNotice, useLiveStreamingSpeed } from './views.js';
import { PendingQueue, PendingQueueEdit } from './pending-queue.js';
import type { InteractionInputHandler } from './interaction-input.js';
import { runBangShell } from './bang-shell.js';
import { useInterrupt } from './interrupt.js';
import { useQueuePaused } from './queue-paused.js';
import { isCtrlG, isCtrlO, isCtrlT, isShiftTab, useProfileClearConfirm } from './shift-tab.js';
import { resolveTypedCommand } from './typed-command.js';
import { REWIND_COMMAND, rewindItems, runRewindCommand } from './menus/rewind-command.js';
import { cleanImageMarkers, wireAttachments } from './draft.js';
import { useSessionComposer } from './session-composer.js';
import { useTerminalSize } from './terminal.js';
import { useCommandTranscriptViewport } from './command-transcript.js';
import { useHarnessInput } from './harness-input.js';
import { replaceSession } from './replace-session.js';
import { runBridgeCommand } from './bridge-command.js';
import { useSendConfirmation } from './send-confirmation.js';
import { BOUNDARY_ROWS, useNewConversationHeader } from './new-conversation.js';
import { useMenuStack } from './menus/menu-host.js';
import { ComposerFooter, ComposerWidth, useComposerFilter, useFooterUsage } from './composer-parts.js';
import { SessionPanels } from './session-panels.js';
import { ApprovalHost, promptRequest } from './approval-host.js';
import { TasksPanel } from './tasks-panel.js';
import { useSessionRewind } from './session-rewind.js';
import { useEscapeKey } from './use-escape-key.js';
import { useShellMode } from './shell-mode.js';
import { useQueueSelection } from './queue-selection.js';
import { useInterruptConfirm } from './interrupt-confirm.js';
import { useHandoff, type HandoffHolder } from './use-handoff.js';
import { useGoalClosedNotice } from './goal-closed-notice.js';
import { useLargeUncachedAdvisory } from './large-uncached-advisory.js';
import { directSlashCommand, listRewindTargets, submitText, previewSendHold, WireCommandFailure } from './commands.js';
export function TuiSession({
  connection,
  header,
  headerHeight,
  redrawKey,
  integration,
  retainedSnapshot,
  onSnapshot,
  onLiveEvent,
  onExit,
  interrupt,
  switchSession,
  transitionNotice,
  resumed = false,
  beginNewConversation,
  newConversation,
  handoff,
}: TuiProps & {
  readonly interrupt: React.RefObject<() => void>;
  readonly switchSession?: (
    sessionId: string,
    notice?: string,
    opening?: readonly string[],
    resumed?: boolean,
  ) => Promise<void>;
  readonly transitionNotice?: string;
  /** Entered by an in-app /resume, where legacy's footer shows the restored session's totals. */
  readonly resumed?: boolean;
  /** The next session to mount opens as a new conversation with these lines (null cancels). */
  readonly beginNewConversation?: (lines: readonly string[] | null) => void;
  /** This session opened as a new conversation: legacy's SessionBoundary above the banner, then these lines. */
  readonly newConversation?: readonly string[];
  readonly handoff?: HandoffHolder;
}): React.ReactElement {
  const goalClosed = useRef<(event: WireEvent) => void>(() => undefined);
  const live = (event: WireEvent) => (goalClosed.current(event), onLiveEvent?.(event));
  const { state, error: connError, historyRevision } = useClient(connection, retainedSnapshot, onSnapshot, live);
  const preferences = integration.preferences?.(connection.sessionId) ?? terminalPreferenceDefaults();
  const { columns, rows } = useTerminalSize();
  const liveTps = useLiveStreamingSpeed(state);
  const footerState = useFooterUsage(state, resumed);
  const [answeredId, setAnsweredId] = useState<string | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  // Legacy's addSystemMessage: every command result and hint is a transcript line, never a live notice.
  const appendSystem = useRef<(text: string) => void>(() => undefined);
  const setNotice = useCallback((text: string | null) => {
    if (text) appendSystem.current(text);
  }, []);
  const {
    images,
    setImages,
    clearSubmittedParts,
    cancelInput,
    steerRecovery,
    rewindDraft,
    onImagesChange,
    otherParts,
    originalParts,
    editing,
    editor,
    replaceInput,
    changeInput,
    restoreDraft,
    startQueueEdit,
    cancelQueueEdit,
    submitQueueEdit,
  } = useSessionComposer(state, preferences.historySize, setNotice);
  // Snapshot-derived ownership leaves no gap for decision keys to land in the composer.
  const prompt = promptRequest(state, answeredId);
  const panelOpen = taskOpen || budgetOpen;
  const shown = !panelOpen ? prompt : undefined;
  const foregroundInteraction = shown?.interaction;
  const interactionActive = Boolean(foregroundInteraction);
  const confirmation = useSendConfirmation(interactionActive);
  const interactionInput = useRef<InteractionInputHandler | null>(null);
  const approvalInterrupt = useRef<(() => boolean) | null>(null);
  const viewportActive = !interactionActive && !panelOpen && !confirmation.pending;
  const sessionHeader = useNewConversationHeader(header, newConversation, columns);
  const viewport = useCommandTranscriptViewport(
    state,
    (headerHeight ?? 0) + (newConversation ? BOUNDARY_ROWS : 0),
    viewportActive,
    sessionHeader,
    historyRevision,
    { transitionNotices: [...(newConversation ?? []), ...(transitionNotice ? [transitionNotice] : [])], redrawKey },
  );
  appendSystem.current = (text) => viewport.appendCommandOutput(text, true);
  goalClosed.current = useGoalClosedNotice(state, setNotice);
  useEffect(() => {
    const interrupted = interruptedNotice(state);
    if (interrupted) setNotice(interrupted);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { InputFrame, PromptMarker, LiveDivider } = useSkin();
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const handoffPrompting = handoff?.state?.stage === 'confirm_model';
  const composerActive = !panelOpen && !confirmation.pending && !handoffPrompting && !connError && !interactionActive;
  const historyUp = () => {
    const entry = editor.navigate('up', {
      text: editor.value,
      attachments: wireAttachments(images, otherParts, originalParts),
    });
    if (entry) restoreDraft(entry, entry.cursor);
  };
  const queue = useQueueSelection(state, connection, { edit: startQueueEdit, historyUp });
  // Menus call back into `submit`, which is declared below and changes every render.
  const submitRef = useRef<(input: string) => void>(() => undefined);
  const handoffRef = useRef<ReturnType<typeof useHandoff>>(null as never);
  const runCommand = useCallback((text: string) => submitRef.current(text), []);
  const menuStack = useMenuStack({
    menus: integration.menus,
    sessionId: connection.sessionId,
    composer: { value: editor.value, cursor: editor.cursor, replace: replaceInput },
    enabled: composerActive && !editing,
    actions: {
      runCommand,
      notice: setNotice,
      command: (text) => handoffRef.current.command(text, () => integration.command(connection, text)),
      rewind: (item, how) => void executeRewind(item.targetId, how),
    },
  });
  const queuePaused = useQueuePaused({
    state,
    connection,
    active: composerActive && !menuStack.open && !editing,
    draft: editor.value,
    replaceInput,
    notice: setNotice,
  });
  // Legacy InputBox's double Escape clear; menus, panels, the expanded output viewer and the queue take Escape first.
  const shell = useShellMode(editor.value, replaceInput);
  const largeUncached = useLargeUncachedAdvisory(connection, editor.value, !shell.active, state, confirmation);
  const { escHintVisible } = useEscapeKey({
    value: editor.value,
    onChange: (value) => replaceInput(value),
    onEscape: () => {
      if (!composerActive || menuStack.open || viewport.expanded || queue.index >= 0 || Boolean(editing)) return true;
      // Legacy InputBox handleEscape: Esc on an empty shell prompt leaves shell mode.
      return shell.escape();
    },
    turnInFlight: Boolean(state.activeTurnId),
  });
  const pending = useRef(false);
  const { waitUntilRenderFlush } = useApp();
  // Legacy clearInputBeforeReset paints the emptied composer, then printUsage writes under that frame.
  const resetHooks = {
    leave: () => waitUntilRenderFlush().then(() => integration.printUsage?.()),
    begin: beginNewConversation,
  };
  const handoffFlow = useHandoff({
    holder: handoff,
    state,
    connection,
    switchSession,
    resetHooks,
    menuOpen: menuStack.open,
    replaceInput,
    notice: setNotice,
    send: (text) => submit(text, []),
  });
  handoffRef.current = handoffFlow;
  const interruptConfirm = useInterruptConfirm(Boolean(state.activeTurnId), editor.value, () => {
    void cancelInput(connection, state.activeTurnId ?? undefined).then(setNotice, (error: unknown) =>
      setNotice(error instanceof Error ? error.message : String(error)),
    );
  });
  const profileClear = useProfileClearConfirm(integration, connection, confirmation, setNotice, beginNewConversation);
  const composerFilter = useComposerFilter({
    composerActive,
    outputExpanded: viewport.expanded,
    draft: { value: editor.value, cursor: editor.cursor, replace: replaceInput },
    submit: (text) => void submit(text, images),
  });
  useInterrupt({
    interrupt,
    approvalInterrupt: foregroundInteraction ? approvalInterrupt : null,
    connection,
    confirmation,
    state,
    editor: menuStack.typed,
    cancelInput,
    setNotice,
    cancelQueueEdit,
  });
  useInput((input, key) => {
    if (menuStack.open) return;
    if (confirmation.handleKey(input, key)) return;
    if (interactionActive) return void interactionInput.current?.(input, key);
    if (taskOpen || budgetOpen) return;
    if (composerActive && key.escape && handoffFlow.escape()) return;
    if (composerActive && key.escape && !viewport.expanded && queue.index < 0 && !editing && interruptConfirm.press())
      return;
    // Legacy's Shift+Tab entered Plan mode, a dropped profile (#149): the key is consumed and does nothing.
    if (composerActive && isShiftTab(input, key)) return;
    // Legacy use-app-keyboard-shortcuts: Ctrl+O and Ctrl+T replace the draft with the menu command.
    if (composerActive && isCtrlO(input, key)) return replaceInput('/model ');
    if (composerActive && isCtrlT(input, key)) return replaceInput('/effort ');
    if (composerActive && key.escape && viewport.expanded) return viewport.collapse();
    // Legacy's Ctrl+G is only the background task manager, and it opens only when there is live work to manage.
    const liveTasks = state.tasks.some((task) => task.status === 'running' || task.status === 'awaiting_interaction');
    if (isCtrlG(input, key) && !busy && liveTasks) setTaskOpen(true);
    if (key.ctrl && input === 'b' && state.budgets.length && !busy) setBudgetOpen(true);
    if (key.meta && key.return && state.activeTurnId && !busy && !editing)
      void submit(editor.value, images, 'follow_up');
  });
  const { executeRewind, rewindHidden } = useSessionRewind({
    connection,
    pending,
    rewindDraft,
    setBusy,
    viewport,
    setNotice,
  });
  const harnessActive = composerActive && !menuStack.owns && !busy;
  // Not under an Esc-closed menu's placeholder: the input that takes the next keys mounts a render later.
  const harnessMounted = (menuStack.open || !rewindHidden) && !menuStack.closedEmpty;
  useHarnessInput(harnessActive, Boolean(state.activeTurnId), menuStack.value, harnessMounted);
  const submit = async (
    input: string,
    submittedImages: ImageRef[] = images,
    delivery: WireSubmission['delivery'] = state.activeTurnId ? 'steer' : 'auto',
    confirmed = false,
    fromMenu = false, // legacy's menus clear the input first, so their commands' failures only report
  ): Promise<void> => {
    if (handoffFlow.submit(input)) return;
    input = menuStack.withPendingSkill(input);
    const clean = cleanImageMarkers(input);
    if (!clean.trim() && !submittedImages.length && !otherParts.length && !editing) return;
    if (pending.current) {
      // The composer is already empty and a send is in flight: keep this message as the draft instead of losing it.
      replaceInput(editor.value ? `${input}\n${editor.value}` : input);
      setImages(submittedImages);
      return setNotice('Still sending the previous message. Press Enter again to send this one.');
    }
    pending.current = true;
    const submission = steerRecovery.beginSubmission(input, submittedImages, otherParts);
    setBusy(true);
    setNotice(null);
    viewport.setHelp(null);
    // True when the draft was held for confirmation instead of sent.
    const held = async (text: string, attachments: readonly WireContent[], retry: () => void): Promise<boolean> => {
      if (confirmed) return false;
      // Enter cleared the composer (text, images): restore the draft whenever nothing was sent.
      const keepDraft = () => {
        replaceInput(input);
        setImages(submittedImages);
      };
      const hold = await previewSendHold(connection, text, attachments).catch((e) => (keepDraft(), Promise.reject(e)));
      if (hold === null) return false;
      keepDraft();
      confirmation.holdSend(hold, retry, footerState.lastUsage);
      return true;
    };
    try {
      if (editing) {
        const notice = await submitQueueEdit(connection, clean, submittedImages, submission.submissionEpoch);
        if (notice) setNotice(notice);
        return;
      }
      // Legacy resolves a typed command by exact name in any case or by a unique prefix, and refuses the rest.
      const typed = resolveTypedCommand(input);
      if (typed.kind === 'refused') throw new Error(typed.notice);
      const command = typed.kind === 'command' ? typed.input : input;
      if (typed.kind === 'command' && submittedImages.length)
        throw new Error('Remove attachments before running a command.');
      if (command.startsWith('!')) {
        const attached = submittedImages.length > 0 || otherParts.length > 0;
        viewport.appendShell(
          await runBangShell(integration, connection, command, attached, Boolean(state.activeTurnId)),
        );
      } else if (REWIND_COMMAND.test(command.trim())) {
        const chosen = await runRewindCommand(command, {
          listItems: async () => rewindItems(await listRewindTargets(connection)),
          addSystemMessage: setNotice,
          openRewindMenu: (items, how) => menuStack.openMenu({ kind: 'rewind', items, initialDisposition: how }),
        });
        if (chosen) {
          pending.current = false;
          setBusy(false);
          await executeRewind(chosen.item.targetId, chosen.disposition);
          return;
        }
      } else if (/^\/bridge(?:\s|$)/.test(command)) {
        setNotice(await runBridgeCommand(integration, command));
      } else if (command.trim() === '/clear') {
        const failure = await replaceSession(connection, switchSession, undefined, resetHooks);
        if (failure !== null) {
          setNotice(failure);
          editor.accepted(input, true, []);
          return;
        }
      } else if (/^\/handoff(?:\s|$)/.test(command)) {
        handoffFlow.start();
      } else if (/^\/providers(?:\s|$)/.test(command)) {
        if (!menuStack.openFrame('providers')) throw new Error('Provider management is unavailable.');
      } else if (typed.kind === 'command') {
        // directSlashCommand announces /compact ('Compacting context...') before the summary request starts.
        const directNotice = await directSlashCommand(connection, command, setNotice);
        if (directNotice !== null) setNotice(directNotice);
        else {
          const result = await handoffFlow.command(command, () => integration.command(connection, command));
          // A session switch carries its message into the new session, which remounts.
          if (result.message && !result.sessionId) viewport.showMessage(result.message, command);
          // Legacy adds command output (/usage) as a system message, like /help.
          if (result.transcript) viewport.appendCommandOutput(result.transcript, true);
          if (result.menu) menuStack.openMenu(result.menu);
          if (result.confirmClear) profileClear.confirmClear(result.confirmClear);
          if (result.draft) {
            restoreDraft(result.draft);
            return;
          }
          if (result.sessionId) {
            if (!switchSession) throw new Error(`Session ${result.sessionId} needs an app session switch.`);
            await switchSession(result.sessionId, result.message, undefined, command.trim().startsWith('/resume'));
          }
          // Legacy clearInputBeforeReset: the emptied composer is painted before Ink unmounts.
          if (result.exit) {
            replaceInput('');
            await waitUntilRenderFlush();
            onExit();
          }
        }
      } else {
        const parts = wireAttachments(submittedImages, otherParts, originalParts);
        if (await held(clean, parts, () => void submit(input, submittedImages, delivery, true))) return;
        await submitText(connection, clean, parts, delivery, state.activeTurnId ?? undefined, submission.requestId);
        clearSubmittedParts(submittedImages, otherParts);
      }
      // Legacy records only admitted chat turns (conversation-admission-workflow.ts): no commands or `!` shell.
      editor.accepted(
        input,
        !/^[/!]/.test(input),
        input.startsWith('/') ? [] : wireAttachments(submittedImages, otherParts, originalParts),
        submission.submittedRevision,
        clean,
      );
    } catch (error) {
      if (error instanceof WireCommandFailure && error.code === 'steer_target_stopped') {
        await steerRecovery.restoreLateSteer(input, wireAttachments(submittedImages, otherParts, originalParts));
        setNotice(steerRecovery.lateSteerNotice(submission.submissionEpoch, error.message));
      } else {
        // Legacy clears a refused slash command (the slash menu would reopen on it); other input is kept.
        if (fromMenu) {
          // A menu's command leaves the composer as the menu left it.
        } else if (input.startsWith('/')) editor.accepted(input, true, [], submission.submittedRevision);
        else await editor.restoreRejected(input);
        const message = error instanceof Error ? error.message : String(error);
        setNotice(
          input.startsWith('/') || input.startsWith('!')
            ? message
            : `${message} Draft kept; check the conversation before retrying.`,
        );
      }
    } finally {
      steerRecovery.endSubmission(submission.requestId);
      pending.current = false;
      setBusy(false);
    }
  };
  submitRef.current = (text) => void submit(text, [], undefined, false, true);
  return (
    <Box flexDirection="column">
      {viewport.staticTranscript}
      {viewport.text.trim() ? <Text>{viewport.text}</Text> : null}
      {viewport.paged && viewport.total > 0 && (viewport.start > 0 || !viewport.live) ? (
        <Text color={theme.textSubtle}>
          Lines {viewport.start + 1}–{viewport.end} of {viewport.total} · PgUp/PgDn or Ctrl+↑/↓
        </Text>
      ) : null}
      <Box flexDirection="column" paddingX={2} marginTop={viewport.bottomMargin}>
        <Activity
          state={{ ...state, interactions: state.interactions.filter((item) => item.id !== answeredId) }}
          dialogInteractionId={foregroundInteraction?.id}
          liveTps={liveTps}
        />
        <SessionPanels
          {...{
            connection,
            interactionInput,
            budgetOpen,
            state,
            columns,
          }}
          onNotice={setNotice}
          closeBudget={() => setBudgetOpen(false)}
        />
        <LiveNotices connectionError={connError} />
        <LiveNotices historyError={editor.historyError} />
        <LiveDivider />
        {menuStack.firstRunPrompt}
        {interruptConfirm.interruptConfirmVisible ? (
          <Box marginBottom={1}>
            <Text color={theme.warning}>Press Esc again to interrupt</Text>
          </Box>
        ) : null}
        <ApprovalHost
          request={shown}
          activeTurnId={state.activeTurnId}
          {...{ connection, cancelInput, setNotice, changeInput, replaceInput, editorValue: editor.value }}
          inputHandler={interactionInput}
          interrupt={approvalInterrupt}
          onStopped={() => viewport.appendCommandOutput('Stopped', 'system')}
          hide={setAnsweredId}
          panel={<TasksPanel {...{ state, connection }} manager={[taskOpen, setTaskOpen]} gap={!shown} />}
        />
        <Box flexDirection="column" display={foregroundInteraction || taskOpen ? 'none' : 'flex'}>
          {/* Legacy keeps the queue list in the input surface, which a menu or the paused prompt replaces. */}
          {queuePaused.prompt ??
            (menuStack.open ? null : (
              <PendingQueue
                items={queue.items}
                selectedId={queue.selectedId}
                editingId={editing?.id ?? null}
                notice={queue.notice}
              />
            ))}
          <PendingQueueEdit editingId={editing?.id ?? null} items={queue.items} />
          {menuStack.view}
          {/* Legacy BottomArea puts a confirmation prompt in the composer's place. */}
          {confirmation.prompt ?? handoffFlow.prompt}
          {handoffFlow.promptLabel && !menuStack.open ? (
            <Text color={theme.accent}>{handoffFlow.promptLabel}</Text>
          ) : null}
          {menuStack.owns || rewindHidden || confirmation.prompt || handoffFlow.prompt || queuePaused.shown ? null : (
            <ComposerWidth columns={columns} fullWidth={menuStack.handingBack}>
              {(width) => (
                <InputFrame>
                  <PromptMarker mode={shell.active ? 'shell' : 'input'} />
                  {menuStack.closedEmpty ? (
                    // A menu closed empty (Esc) on this render: draw the empty input legacy's editor shows, and mount
                    // the input once the hand-back has cleared the composer.
                    <Text inverse> </Text>
                  ) : (
                    <MultilineInput
                      key={editor.inputKey}
                      value={editor.value}
                      onChange={(value) => shell.change(value) || changeInput(value)}
                      onSubmit={(value, submittedImages = []) => {
                        if (
                          !shell.submit(value, submittedImages.length > 0, (command) =>
                            submit(command, submittedImages),
                          )
                        )
                          void submit(value, submittedImages);
                      }}
                      onBoundaryArrow={(direction) => {
                        if (shell.active) return;
                        if (direction === 'up' && !editor.value && !editing && queue.open()) return;
                        const entry = editor.navigate(direction, {
                          text: editor.value,
                          attachments: wireAttachments(images, otherParts, originalParts),
                        });
                        if (entry) restoreDraft(entry, entry.cursor);
                      }}
                      onCursorChange={(offset) => {
                        editor.cursorChanged(offset);
                        menuStack.cursorChanged(offset);
                      }}
                      cursorOverride={editor.cursorOverride}
                      width={width}
                      maxHeight={Math.max(1, rows - 8)}
                      pasteThreshold={preferences.pasteThreshold}
                      isActive={composerActive}
                      images={images}
                      onImagesChange={onImagesChange}
                      enableImagePaste
                      onPasteError={(reason) => setNotice(`Image paste failed: ${reason}`)}
                      ignoreInput={(input, key) => {
                        if (queue.key(input, key)) return true;
                        if (editing && key.escape) return cancelQueueEdit();
                        return shell.key(input, key) || composerFilter(input, key);
                      }}
                    />
                  )}
                </InputFrame>
              )}
            </ComposerWidth>
          )}
        </Box>
        <ComposerFooter
          integration={integration}
          state={footerState}
          liveTps={liveTps}
          active={composerActive && queue.index < 0 && !menuStack.open && !queuePaused.shown}
          // Legacy hides the idle hints under a prompt label.
          draftEmpty={(menuStack.closedEmpty || editor.value === '') && !handoffFlow.promptLabel}
          escHint={escHintVisible}
          columns={columns - 4}
          queueSelectable={queue.items.length > 0 && !editor.value && !editing}
          largeUncached={largeUncached}
        />
      </Box>
    </Box>
  );
}
