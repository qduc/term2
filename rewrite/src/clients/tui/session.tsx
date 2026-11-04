import React, { useCallback, useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { Box, Text, useInput } from 'ink';
import { MultilineInput, type ImageRef } from 'ink-prompt';
import type { TuiProps } from './integration.js';
import type { WireContent, WireSubmission } from '../../protocol/direct-wire.js';
import { useTheme } from './presentation/components/theme.js';
import { useSkin } from './presentation/skins/SkinContext.js';
import { terminalPreferenceDefaults } from '../../host/terminal-preference-defaults.js';
import { useClient } from './use-client.js';
import {
  ShellTaskPanel,
  Activity,
  BangResult,
  LiveNotices,
  interruptedNotice,
  useLiveStreamingSpeed,
} from './views.js';
import { PendingQueue, PendingQueueEdit } from './pending-queue.js';
import type { InteractionInputHandler } from './interaction-input.js';
import { runBangShell } from './bang-shell.js';
import { useInterrupt } from './interrupt.js';
import { runQueueCommand } from './queue-command.js';
import { withSkillPrefix } from './skill-edit.js';
import { isCtrlG, isCtrlO, isCtrlT, isShiftTab, usePlanToggle } from './shift-tab.js';
import { resolveTypedCommand } from './typed-command.js';
import { REWIND_COMMAND, rewindItems, runRewindCommand } from './menus/rewind-command.js';
import { cleanImageMarkers, primaryDraft, wireAttachments } from './draft.js';
import { numberedInteractionAnswer } from './interaction-command.js';
import { useSessionComposer } from './session-composer.js';
import { useTerminalSize } from './terminal.js';
import { useCommandTranscriptViewport } from './command-transcript.js';
import { useHarnessInput } from './harness-input.js';
import { replaceSession } from './replace-session.js';
import { runBridgeCommand } from './bridge-command.js';
import { useSendConfirmation } from './send-confirmation.js';
import { useMenuStack } from './menus/menu-host.js';
import { ComposerFooter, useComposerFilter } from './composer-parts.js';
import { SessionPanels } from './session-panels.js';
import { useSessionRewind } from './session-rewind.js';
import { useEscapeKey } from './use-escape-key.js';
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
}: TuiProps & {
  readonly interrupt: React.RefObject<() => void>;
  readonly switchSession?: (sessionId: string, notice?: string) => Promise<void>;
  readonly transitionNotice?: string;
}): React.ReactElement {
  const { state, error: connError, historyRevision } = useClient(connection, retainedSnapshot, onSnapshot, onLiveEvent);
  const preferences = integration.preferences?.(connection.sessionId) ?? terminalPreferenceDefaults();
  const { columns, rows } = useTerminalSize();
  const liveTps = useLiveStreamingSpeed(state);
  const [bangResult, setBangResult] = useState<string | null>(null);
  const [interactionOpen, setInteractionOpen] = useState(false);
  const [dismissedInteractionId, setDismissedInteractionId] = useState<string | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [notice, setLiveNotice] = useState<string | null>(() => interruptedNotice(state));
  // Legacy reports through addSystemMessage: each line stays in the transcript, in order, instead of one live notice.
  const systemMessage = useRef<(text: string) => void>(() => undefined);
  const setNotice = useCallback((text: string | null) => {
    if (text) systemMessage.current(text);
    else setLiveNotice(null);
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
  const viewport = useCommandTranscriptViewport(state, headerHeight ?? 0, viewportActive, header, historyRevision, {
    transitionNotice,
  });
  systemMessage.current = (text) => viewport.appendCommandOutput(text, true);
  const { InputFrame, PromptMarker, LiveDivider } = useSkin();
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const composerActive = !panelOpen && !confirmation.pending && !connError && !interactionActive;
  const queueItems = ['steering', 'queued'].flatMap((delivery) =>
    state.queue.filter((item) => item.delivery === delivery),
  );
  const selectedQueueIndex = queueItems.findIndex((item) => item.id === selectedQueueId);
  // Menus call back into `submit`, which is declared below and changes every render.
  const submitRef = useRef<(input: string) => void>(() => undefined);
  const runCommand = useCallback((text: string) => submitRef.current(text), []);
  const menuStack = useMenuStack({
    menus: integration.menus,
    sessionId: connection.sessionId,
    composer: { value: editor.value, cursor: editor.cursor, replace: replaceInput },
    enabled: composerActive && !editing,
    actions: {
      runCommand,
      notice: setNotice,
      command: (text) => integration.command(connection, text),
      rewind: (item, how) => void executeRewind(item.targetId, how),
    },
  });
  useHarnessInput((composerActive || menuStack.open) && !busy, Boolean(state.activeTurnId), menuStack.value);
  // Legacy InputBox's double Escape clear; menus, panels, the expanded output viewer and the queue take Escape first.
  const { escHintVisible } = useEscapeKey({
    value: editor.value,
    onChange: (value) => replaceInput(value),
    onEscape: () =>
      !composerActive || menuStack.open || viewport.expanded || selectedQueueIndex >= 0 || Boolean(editing),
    turnInFlight: Boolean(state.activeTurnId),
  });
  const pending = useRef(false);
  const togglePlan = usePlanToggle(integration, connection, confirmation, Boolean(state.activeTurnId), setNotice);
  const composerFilter = useComposerFilter({
    composerActive,
    turnActive: Boolean(state.activeTurnId),
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
    if (composerActive && isShiftTab(input, key)) return togglePlan();
    // Legacy use-app-keyboard-shortcuts: Ctrl+O and Ctrl+T replace the draft with the menu command.
    if (composerActive && isCtrlO(input, key)) return replaceInput('/model ');
    if (composerActive && isCtrlT(input, key)) return replaceInput('/effort ');
    if (composerActive && key.escape && viewport.expanded) return viewport.collapse();
    if (isCtrlG(input, key) && !busy) (state.interactions.length ? setInteractionOpen : setTaskOpen)(true);
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
    setBangResult(null);
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
      // Legacy resolves a typed command by exact name in any case or by a unique prefix, and refuses the rest.
      const typed = resolveTypedCommand(input);
      if (typed.kind === 'refused') throw new Error(typed.notice);
      const command = typed.kind === 'command' ? typed.input : input;
      if (typed.kind === 'command' && submittedImages.length)
        throw new Error('Remove attachments before running a command.');
      if (command.startsWith('/answer ')) {
        const answer = numberedInteractionAnswer(command, state.interactions, answerOwners.current);
        await answerInteraction(connection, answer.requestId, answer.decision);
      } else if (command.startsWith('!')) {
        const attached = submittedImages.length > 0 || otherParts.length > 0;
        setBangResult(await runBangShell(integration, connection, command, attached, Boolean(state.activeTurnId)));
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
      } else if (/^\/command-(status|apply)(?:\s|$)/.test(command)) {
        const match = /^\/command-(status|apply)\s+(\S+)$/.exec(command.trim());
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
      } else if (command.trim() === '/clear' || command.trim() === '/rollover') {
        const failure = await replaceSession(connection, command.trim() as '/clear' | '/rollover', switchSession);
        if (failure !== null) {
          setNotice(failure);
          editor.accepted(input, true, []);
          return;
        }
      } else if (/^\/queue(?:\s|$)/.test(command)) {
        if (await runQueueCommand(connection, command, state.queue, queueOwners.current, startQueueEdit)) return;
      } else if (command.trim() === '/cancel') {
        setNotice(
          await cancelInput(connection, state.activeTurnId ?? undefined, command, submission.submittedRevision),
        );
        return;
      } else if (/^\/providers(?:\s|$)/.test(command)) {
        if (!menuStack.openFrame('providers')) throw new Error('Provider management is unavailable.');
      } else if (typed.kind === 'command') {
        const directNotice = await directSlashCommand(connection, command);
        if (directNotice !== null) setNotice(directNotice);
        else {
          const result = await integration.command(connection, command);
          // A session switch carries its message into the new session, which remounts.
          if (result.message && !result.sessionId) viewport.showMessage(result.message, command);
          // Legacy adds command output (/usage) as a system message, like /help.
          if (result.transcript) viewport.appendCommandOutput(result.transcript, true);
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
      // Do not add interaction answers to recallable input history.
      editor.accepted(
        input,
        !input.startsWith('/answer '),
        input.startsWith('/') ? [] : wireAttachments(submittedImages, otherParts, originalParts),
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
        <Activity state={state} dialogInteractionId={foregroundInteraction?.id} notice={notice} liveTps={liveTps} />
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
        {confirmation.prompt}
        <LiveNotices notice={notice} historyError={editor.historyError} />
        {bangResult ? <BangResult result={bangResult} expanded={viewport.expanded} /> : null}
        <LiveDivider />
        <ShellTaskPanel state={state} />
        <PendingQueue
          items={queueItems}
          selectedId={selectedQueueIndex < 0 ? null : selectedQueueId}
          editingId={editing?.id ?? null}
          notice={queueNotice}
        />
        <PendingQueueEdit editingId={editing?.id ?? null} items={queueItems} />
        {menuStack.view}
        {menuStack.open ? null : (
          <InputFrame>
            <PromptMarker mode="input" />
            <MultilineInput
              key={editor.inputKey}
              value={editor.value}
              onChange={(value) => {
                changeInput(value);
              }}
              onSubmit={(value, submittedImages) => {
                void submit(value, submittedImages);
              }}
              onBoundaryArrow={(direction) => {
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
                return composerFilter(input, key);
              }}
            />
          </InputFrame>
        )}
        <ComposerFooter
          integration={integration}
          state={state}
          liveTps={liveTps}
          active={composerActive && selectedQueueIndex < 0 && !menuStack.open}
          draftEmpty={editor.value === ''}
          escHint={escHintVisible}
          columns={columns - 4}
          queueSelectable={queueItems.length > 0 && !editor.value && !editing}
        />
      </Box>
    </Box>
  );
}
