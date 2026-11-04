import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { Box, Text, useInput } from 'ink';
import { MultilineInput, type ImageRef } from 'ink-prompt';
import type { TuiProps } from './integration.js';
import type { WireContent, WireSubmission } from '../../protocol/direct-wire.js';
import { useTheme } from './presentation/components/theme.js';
import { useSkin } from './presentation/skins/SkinContext.js';
import { terminalPreferenceDefaults } from '../../host/terminal-preference-defaults.js';
import { useClient } from './use-client.js';
import { ShellTaskPanel, Activity, LiveNotices, interruptedNotice } from './views.js';
import { PendingQueue, PendingQueueEdit } from './pending-queue.js';
import type { InteractionInputHandler } from './interaction-input.js';
import { runBangShell } from './bang-shell.js';
import { useInterrupt } from './interrupt.js';
import { runQueueCommand } from './queue-command.js';
import { withSkillPrefix } from './skill-edit.js';
import { isCtrlG, isCtrlO, isCtrlT, isShiftTab, usePlanToggle } from './shift-tab.js';
import { REWIND_COMMAND, rewindItems, runRewindCommand } from './menus/rewind-command.js';
import { cleanImageMarkers, primaryDraft, wireAttachments } from './draft.js';
import { numberedInteractionAnswer } from './interaction-command.js';
import { useSessionComposer } from './session-composer.js';
import { useTerminalSize } from './terminal.js';
import { useCommandTranscriptViewport } from './command-transcript.js';
import { useHarnessInput } from './harness-input.js';
import { replaceSession, WELCOME } from './replace-session.js';
import { runBridgeCommand } from './bridge-command.js';
import { useSendConfirmation } from './send-confirmation.js';
import SessionBoundary from './presentation/components/message/SessionBoundary.js';
import { useMenuStack } from './menus/menu-host.js';
import { ComposerFooter, useComposerFilter } from './composer-parts.js';
import { SessionPanels } from './session-panels.js';
import { useSessionRewind } from './session-rewind.js';
import { useEscapeKey } from './use-escape-key.js';
import { useInterruptConfirm } from './interrupt-confirm.js';
import { useHandoff, type HandoffHolder } from './use-handoff.js';
import {
  answerInteraction,
  commandStatus,
  directSlashCommand,
  listRewindTargets,
  queueAction,
  receiptNotice,
  submitText,
  previewConfirmation,
  WireCommandFailure,
} from './commands.js';
export function TuiSession({
  connection,
  header,
  headerHeight,
  integration,
  retainedSnapshot,
  onSnapshot,
  onLiveEvent,
  onExit,
  interrupt,
  switchSession,
  transitionNotice,
  beginNewConversation,
  newConversation,
  handoff,
}: TuiProps & {
  readonly interrupt: React.RefObject<() => void>;
  readonly switchSession?: (sessionId: string, notice?: string, opening?: readonly string[]) => Promise<void>;
  readonly transitionNotice?: string;
  /** The next session to mount opens as a new conversation with these lines (null cancels). */
  readonly beginNewConversation?: (lines: readonly string[] | null) => void;
  /** This session opened as a new conversation: legacy's SessionBoundary above the banner, then these lines. */
  readonly newConversation?: readonly string[];
  readonly handoff?: HandoffHolder;
}): React.ReactElement {
  const { state, error: connError, historyRevision } = useClient(connection, retainedSnapshot, onSnapshot, onLiveEvent);
  const preferences = integration.preferences?.(connection.sessionId) ?? terminalPreferenceDefaults();
  const { columns, rows } = useTerminalSize();
  const [interactionOpen, setInteractionOpen] = useState(false);
  const [dismissedInteractionId, setDismissedInteractionId] = useState<string | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null);
  // Legacy useShellMode: `!` on an empty composer swaps the prompt for a shell prompt; the `!` is not typed.
  const [shellMode, setShellMode] = useState(false);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
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
    setOtherParts,
    originalParts,
    setOriginalParts,
    editing,
    setEditing,
    editor,
    replaceInput,
    changeInput,
    restoreDraft,
    startQueueEdit,
    answerOwners,
    queueOwners,
  } = useSessionComposer(state, preferences.historySize, setNotice);
  // Snapshot-derived ownership leaves no gap for decision keys to land in the composer; Ctrl+G picks background requests.
  const rootInteraction = state.interactions.find((item) => item.turnId === state.activeTurnId && !item.taskId);
  const panelOpen = taskOpen || budgetOpen;
  const foregroundInteraction =
    !interactionOpen && !panelOpen && rootInteraction?.id !== dismissedInteractionId ? rootInteraction : undefined;
  const interactionActive = interactionOpen || Boolean(foregroundInteraction);
  const confirmation = useSendConfirmation(interactionActive);
  const interactionInput = useRef<InteractionInputHandler | null>(null);
  const viewportActive = !interactionActive && !panelOpen && !confirmation.pending;
  const sessionHeader = useMemo(
    () =>
      newConversation ? (
        <Box flexDirection="column">
          <Box paddingX={2}>
            <SessionBoundary width={Math.max(1, columns - 4)} />
          </Box>
          {header}
        </Box>
      ) : (
        header
      ),
    // The banner is printed once; a later resize must not re-key the static rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [newConversation, header],
  );
  const viewport = useCommandTranscriptViewport(
    state,
    (headerHeight ?? 0) + (newConversation ? 4 : 0),
    viewportActive,
    sessionHeader,
    historyRevision,
    { transitionNotices: [...(newConversation ?? []), ...(transitionNotice ? [transitionNotice] : [])] },
  );
  appendSystem.current = (text) => viewport.appendCommandOutput(text, true);
  useEffect(() => {
    const interrupted = interruptedNotice(state);
    if (interrupted) setNotice(interrupted);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { InputFrame, PromptMarker, LiveDivider } = useSkin();
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const handoffPrompting = handoff?.state?.stage === 'confirm_model';
  const composerActive = !panelOpen && !confirmation.pending && !handoffPrompting && !connError && !interactionActive;
  const queueItems = ['steering', 'queued'].flatMap((delivery) =>
    state.queue.filter((item) => item.delivery === delivery),
  );
  const selectedQueueIndex = queueItems.findIndex((item) => item.id === selectedQueueId);
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
  useHarnessInput((composerActive || menuStack.open) && !busy, Boolean(state.activeTurnId), menuStack.value);
  // Legacy InputBox's double Escape clear; menus, panels, the expanded output viewer and the queue take Escape first.
  const { escHintVisible } = useEscapeKey({
    value: editor.value,
    onChange: (value) => replaceInput(value),
    onEscape: () => {
      if (!composerActive || menuStack.open || viewport.expanded || selectedQueueIndex >= 0 || Boolean(editing))
        return true;
      // Legacy InputBox handleEscape: Esc on an empty shell prompt leaves shell mode.
      if (shellMode && editor.value === '') {
        setShellMode(false);
        return true;
      }
      return false;
    },
    turnInFlight: Boolean(state.activeTurnId),
  });
  const pending = useRef(false);
  const handoffFlow = useHandoff({
    holder: handoff,
    state,
    connection,
    switchSession,
    beginNewConversation,
    menuOpen: menuStack.open,
    replaceInput,
    notice: setNotice,
    send: (text) => void submit(text, []),
  });
  handoffRef.current = handoffFlow;
  const interruptConfirm = useInterruptConfirm(Boolean(state.activeTurnId), editor.value, () => {
    void cancelInput(connection, state.activeTurnId ?? undefined).then(setNotice, (error: unknown) =>
      setNotice(error instanceof Error ? error.message : String(error)),
    );
  });
  const togglePlan = usePlanToggle(
    integration,
    connection,
    confirmation,
    Boolean(state.activeTurnId),
    setNotice,
    beginNewConversation,
  );
  const composerFilter = useComposerFilter({
    composerActive,
    outputExpanded: viewport.expanded,
    draft: { value: editor.value, cursor: editor.cursor, replace: replaceInput },
    submit: (text) => void submit(text, images),
  });
  const cancelQueueEdit = () => {
    if (!editing) return false;
    replaceInput(editing.restoreText, editing.restoreCursor);
    setImages(editing.restoreImages);
    setOtherParts(editing.restoreOther);
    setOriginalParts(editing.restoreOriginal);
    setEditing(null);
    return true;
  };
  useInterrupt({
    interrupt,
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
    if (
      composerActive &&
      key.escape &&
      !viewport.expanded &&
      selectedQueueIndex < 0 &&
      !editing &&
      interruptConfirm.press()
    )
      return;
    if (composerActive && isShiftTab(input, key)) return togglePlan();
    // Legacy use-app-keyboard-shortcuts: Ctrl+O and Ctrl+T replace the draft with the menu command.
    if (composerActive && isCtrlO(input, key)) return replaceInput('/model ');
    if (composerActive && isCtrlT(input, key)) return replaceInput('/effort ');
    if (composerActive && key.escape && viewport.expanded) return viewport.collapse();
    // Legacy BackgroundTaskManager opens only when there is live work to manage.
    const liveTasks = state.tasks.some((task) => task.status === 'running' || task.status === 'awaiting_interaction');
    if (isCtrlG(input, key) && !busy && state.interactions.length) setInteractionOpen(true);
    else if (isCtrlG(input, key) && !busy && liveTasks) setTaskOpen(true);
    if (key.ctrl && input === 'b' && state.budgets.length && !busy) setBudgetOpen(true);
    if (key.meta && key.return && state.activeTurnId && !busy && !editing)
      void submit(editor.value, images, 'follow_up');
  });
  const executeRewind = useSessionRewind({ connection, pending, rewindDraft, setBusy, setNotice });
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
      const message = await previewConfirmation(connection, text, attachments).catch(
        (e) => (keepDraft(), Promise.reject(e)),
      );
      if (message === null) return false;
      keepDraft();
      confirmation.hold(message, retry);
      return true;
    };
    try {
      if (editing) {
        if (input.trim() === '/queue cancel') {
          replaceInput(editing.restoreText, editing.restoreCursor);
          setImages(editing.restoreImages);
          setOtherParts(editing.restoreOther);
          setOriginalParts(editing.restoreOriginal);
          setEditing(null);
          return;
        }
        try {
          const parts = wireAttachments(submittedImages, otherParts, originalParts);
          if (!editing.knownParts && parts.length)
            throw new Error('Queued attachments are unavailable; cannot safely replace them.');
          const changed = editing.knownParts && JSON.stringify(parts) !== JSON.stringify(editing.knownParts);
          await queueAction(
            connection,
            'edit',
            editing.id,
            withSkillPrefix(editing.skillPrefix, clean),
            changed ? parts : undefined,
          );
          if (await steerRecovery.wasEditInvalidatedAfter(submission.submissionEpoch, editing.id)) return;
          replaceInput(editing.restoreText, editing.restoreCursor);
          setImages(editing.restoreImages);
          setOtherParts(editing.restoreOther);
          setOriginalParts(editing.restoreOriginal);
          setEditing(null);
          setNotice('Queued message updated.');
          return;
        } catch (error) {
          if (await steerRecovery.wasEditInvalidatedAfter(submission.submissionEpoch, editing.id, true)) return;
          if (error instanceof WireCommandFailure && error.code === 'too_late') {
            setEditing(null);
            setNotice(
              editing.knownParts
                ? 'Queued input is no longer editable. Your edited draft and attachments are preserved; review before resubmitting.'
                : 'Queued input is no longer editable. Your edited text is preserved, but original attachments were unavailable; review before resubmitting.',
            );
            return;
          }
          throw error;
        }
      }
      if (input.startsWith('/') && !/^\/(steer|followup)\s/.test(input) && submittedImages.length)
        throw new Error('Remove attachments before running a command.');
      if (input.startsWith('/answer ')) {
        const answer = numberedInteractionAnswer(input, state.interactions, answerOwners.current);
        await answerInteraction(connection, answer.requestId, answer.decision);
      } else if (/^\/(steer|followup)(?:\s|$)/.test(input)) {
        const match = /^\/(steer|followup)\s+([\s\S]*)$/.exec(input);
        if (!match || (!match[2].trim() && !submittedImages.length))
          throw new Error('Enter a message after /steer or /followup.');
        const parts = wireAttachments(submittedImages, otherParts, originalParts);
        if (await held(cleanImageMarkers(match[2]), parts, () => void submit(input, submittedImages, delivery, true)))
          return;
        await submitText(
          connection,
          cleanImageMarkers(match[2]),
          wireAttachments(submittedImages, otherParts, originalParts),
          match[1] === 'steer' ? 'steer' : 'follow_up',
          match[1] === 'steer' ? state.activeTurnId ?? undefined : undefined,
          submission.requestId,
        );
        if (await steerRecovery.wasReturnedAfter(submission.submissionEpoch, submission.requestId)) return;
        clearSubmittedParts(submittedImages, otherParts);
      } else if (input.startsWith('!')) {
        const attached = submittedImages.length > 0 || otherParts.length > 0;
        viewport.appendShell(await runBangShell(integration, connection, input, attached, Boolean(state.activeTurnId)));
      } else if (input.trim() === '/tasks') setTaskOpen(true);
      else if (REWIND_COMMAND.test(input.trim())) {
        const chosen = await runRewindCommand(input, {
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
      } else if (/^\/bridge(?:\s|$)/.test(input)) {
        setNotice(await runBridgeCommand(integration, input));
      } else if (/^\/command-(status|apply)(?:\s|$)/.test(input)) {
        const match = /^\/command-(status|apply)\s+(\S+)$/.exec(input.trim());
        if (!match) throw new Error('Use /command-status <id> or /command-apply <id>.');
        const result = await commandStatus(connection, match[2]);
        if (match[1] === 'status' || result.kind !== 'finished') {
          setNotice(receiptNotice(result));
        } else {
          const outcome = result.receipt.outcome;
          if (outcome?.kind === 'rewound') {
            restoreDraft(primaryDraft(outcome.draft.content));
            setNotice('Rewind draft restored. Review before sending.');
            return;
          }
          if (outcome?.kind === 'rolled_over') {
            if (!switchSession) throw new Error(`Session ${outcome.sessionId} needs an app session switch.`);
            await switchSession(outcome.sessionId);
          } else setNotice(receiptNotice(result));
        }
      } else if (input.trim() === '/clear' || input.trim() === '/rollover') {
        // The reset can publish the new session before it answers, so the opening is armed first.
        if (input.trim() === '/clear') beginNewConversation?.([WELCOME]);
        const failure = await replaceSession(connection, input.trim() as '/clear' | '/rollover', switchSession).catch(
          (error: unknown) => {
            beginNewConversation?.(null);
            throw error;
          },
        );
        if (failure !== null) {
          beginNewConversation?.(null);
          setNotice(failure);
          editor.accepted(input, true, []);
          return;
        }
      } else if (/^\/queue(?:\s|$)/.test(input)) {
        if (await runQueueCommand(connection, input, state.queue, queueOwners.current, startQueueEdit)) return;
      } else if (input.trim() === '/cancel') {
        setNotice(await cancelInput(connection, state.activeTurnId ?? undefined, input, submission.submittedRevision));
        return;
      } else if (/^\/handoff(?:\s|$)/.test(input)) {
        handoffFlow.start();
      } else if (/^\/providers(?:\s|$)/.test(input)) {
        if (!menuStack.openFrame('providers')) throw new Error('Provider management is unavailable.');
      } else if (input.startsWith('/')) {
        const directNotice = await directSlashCommand(connection, input);
        if (directNotice !== null) setNotice(directNotice);
        else {
          const result = await handoffFlow.command(input, () => integration.command(connection, input));
          // A session switch carries its message into the new session, which remounts.
          if (result.message && !result.sessionId) viewport.showMessage(result.message, input, setNotice);
          if (result.transcript) viewport.appendCommandOutput(result.transcript);
          if (result.menu) menuStack.openMenu(result.menu);
          if (result.draft) {
            restoreDraft(result.draft);
            return;
          }
          if (result.sessionId) {
            if (!switchSession) throw new Error(`Session ${result.sessionId} needs an app session switch.`);
            await switchSession(result.sessionId, result.message);
          }
          if (result.exit) onExit();
        }
      } else {
        const parts = wireAttachments(submittedImages, otherParts, originalParts);
        if (await held(clean, parts, () => void submit(input, submittedImages, delivery, true))) return;
        await submitText(connection, clean, parts, delivery, state.activeTurnId ?? undefined, submission.requestId);
        if (await steerRecovery.wasReturnedAfter(submission.submissionEpoch, submission.requestId)) return;
        clearSubmittedParts(submittedImages, otherParts);
      }
      // Legacy records only admitted chat turns (conversation-admission-workflow.ts): no commands or `!` shell.
      editor.accepted(
        input,
        !/^[/!]/.test(input) || /^\/(steer|followup)\s/.test(input),
        input.startsWith('/') && !/^\/(steer|followup)\s/.test(input)
          ? []
          : wireAttachments(submittedImages, otherParts, originalParts),
        submission.submittedRevision,
        clean,
      );
      answerOwners.current = null;
      queueOwners.current = null;
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
      {viewport.text ? <Text>{viewport.text}</Text> : null}
      {viewport.paged && viewport.total > 0 && (viewport.start > 0 || !viewport.live) ? (
        <Text color={theme.textSubtle}>
          Lines {viewport.start + 1}–{viewport.end} of {viewport.total} · PgUp/PgDn or Ctrl+↑/↓
        </Text>
      ) : null}
      <Box flexDirection="column" paddingX={2} marginTop={viewport.bottomMargin}>
        <Activity state={state} dialogInteractionId={foregroundInteraction?.id} />
        <SessionPanels
          {...{
            connection,
            interactionInput,
            budgetOpen,
            taskOpen,
            state,
            interactionActive,
            foregroundInteraction,
            columns,
            cancelInput,
          }}
          onNotice={setNotice}
          closeBudget={() => setBudgetOpen(false)}
          closeTask={() => setTaskOpen(false)}
          closeInteraction={() => {
            setDismissedInteractionId(rootInteraction?.id ?? null);
            setInteractionOpen(false);
          }}
        />
        <LiveNotices connectionError={connError} />
        <LiveNotices historyError={editor.historyError} />
        <LiveDivider />
        {interruptConfirm.interruptConfirmVisible ? (
          <Box marginBottom={1}>
            <Text color={theme.warning}>Press Esc again to interrupt</Text>
          </Box>
        ) : null}
        <ShellTaskPanel state={state} />
        <PendingQueue
          items={queueItems}
          selectedId={selectedQueueIndex < 0 ? null : selectedQueueId}
          editingId={editing?.id ?? null}
          notice={queueNotice}
        />
        <PendingQueueEdit editingId={editing?.id ?? null} items={queueItems} />
        {menuStack.view}
        {/* Legacy BottomArea puts a confirmation prompt in the composer's place. */}
        {confirmation.prompt ?? handoffFlow.prompt}
        {handoffFlow.promptLabel && !menuStack.open ? (
          <Text color={theme.accent}>{handoffFlow.promptLabel}</Text>
        ) : null}
        {menuStack.open || confirmation.prompt || handoffFlow.prompt ? null : (
          <InputFrame>
            <PromptMarker mode={shellMode ? 'shell' : 'input'} />
            <MultilineInput
              key={editor.inputKey}
              value={editor.value}
              onChange={(value) => {
                if (!shellMode && editor.value === '' && value.startsWith('!')) {
                  setShellMode(true);
                  replaceInput(value.slice(1));
                  return;
                }
                changeInput(value);
              }}
              onSubmit={(value, submittedImages) => {
                if (shellMode && !submittedImages?.length) {
                  // Legacy handleShellSubmit: a blank command stays in shell mode; any command leaves it.
                  if (!value.trim()) return;
                  replaceInput('');
                  void submit(`!${value}`, submittedImages).finally(() => setShellMode(false));
                  return;
                }
                void submit(value, submittedImages);
              }}
              onBoundaryArrow={(direction) => {
                if (shellMode) return;
                if (direction === 'up' && !editor.value && !editing && queueItems.length) {
                  setQueueNotice(null);
                  setSelectedQueueId(queueItems[queueItems.length - 1]!.id);
                  return;
                }
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
              width={Math.max(1, columns - 6)}
              maxHeight={Math.max(1, rows - 8)}
              pasteThreshold={preferences.pasteThreshold}
              isActive={composerActive}
              images={images}
              onImagesChange={onImagesChange}
              enableImagePaste
              onPasteError={(reason) => setNotice(`Image paste failed: ${reason}`)}
              ignoreInput={(input, key) => {
                if (selectedQueueIndex >= 0) {
                  const item = queueItems[selectedQueueIndex]!;
                  if (key.escape) setSelectedQueueId(null);
                  else if (key.upArrow) {
                    if (selectedQueueIndex > 0) setSelectedQueueId(queueItems[selectedQueueIndex - 1]!.id);
                    else {
                      setSelectedQueueId(null);
                      const entry = editor.navigate('up', {
                        text: editor.value,
                        attachments: wireAttachments(images, otherParts, originalParts),
                      });
                      if (entry) restoreDraft(entry, entry.cursor);
                    }
                  } else if (key.downArrow) setSelectedQueueId(queueItems[selectedQueueIndex + 1]?.id ?? null);
                  else if (input === 'e' || key.return) {
                    setSelectedQueueId(null);
                    setQueueNotice(null);
                    startQueueEdit(item);
                  } else if (input === 'd') {
                    setSelectedQueueId(null);
                    void queueAction(connection, 'retract', item.id).catch((error: unknown) =>
                      setQueueNotice(error instanceof Error ? error.message : String(error)),
                    );
                  }
                  return true;
                }
                if (editing && key.escape) return cancelQueueEdit();
                if (
                  shellMode &&
                  editor.value === '' &&
                  (key.backspace || key.delete || input === '\x7f' || input === '\b')
                ) {
                  setShellMode(false);
                  return true;
                }
                return composerFilter(input, key);
              }}
            />
          </InputFrame>
        )}
        <ComposerFooter
          integration={integration}
          state={state}
          active={composerActive && selectedQueueIndex < 0 && !menuStack.open}
          // Legacy hides the idle hints under a prompt label.
          draftEmpty={editor.value === '' && !handoffFlow.promptLabel}
          escHint={escHintVisible}
          columns={columns - 4}
          queueSelectable={queueItems.length > 0 && !editor.value && !editing}
        />
      </Box>
    </Box>
  );
}
