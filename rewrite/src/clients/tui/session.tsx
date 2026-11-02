import React, { useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { Box, Text, useInput } from 'ink';
import { MultilineInput, type ImageRef } from 'ink-prompt';
import type { TuiProps } from './integration.js';
import type { WireContent, WireRewindTarget, WireSubmission } from '../../protocol/direct-wire.js';
import { useTheme } from './presentation/components/theme.js';
import { useSkin } from './presentation/skins/SkinContext.js';
import { terminalPreferenceDefaults } from '../../host/terminal-preference-defaults.js';
import { useClient } from './use-client.js';
import { Activity, BangResult, LiveNotices, interruptedNotice } from './views.js';
import { InteractionPanel } from './interaction-panel.js';
import type { InteractionInputHandler } from './interaction-input.js';
import { runBangShell } from './bang-shell.js';
import { useInterrupt } from './interrupt.js';
import { runQueueCommand } from './queue-command.js';
import { withSkillPrefix } from './skill-edit.js';
import { PickerHost, pickerFor, openPickerFor, type PickerKind } from './picker-host.js';
import { isCtrlG, isShiftTab, usePlanToggle } from './shift-tab.js';
import { RewindPicker } from './rewind-picker.js';
import { TaskManager } from './task-manager.js';
import { BudgetPanel } from './budget-panel.js';
import { cleanImageMarkers, primaryDraft, wireAttachments } from './draft.js';
import { numberedInteractionAnswer } from './interaction-command.js';
import { useSessionComposer } from './session-composer.js';
import { useTerminalSize } from './terminal.js';
import { useCommandTranscriptViewport } from './command-transcript.js';
import { useHarnessInput } from './harness-input.js';
import { replaceSession } from './replace-session.js';
import { runBridgeCommand } from './bridge-command.js';
import { useSendConfirmation } from './send-confirmation.js';
import { ComposerFooter, useComposerFilter, useComposerMenu } from './composer-parts.js';
import {
  answerBudget,
  answerInteraction,
  commandStatus,
  controlTask,
  directSlashCommand,
  listRewindTargets,
  queueAction,
  receiptNotice,
  sendNativeCommand,
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
  readonly switchSession?: (sessionId: string) => Promise<void>;
  readonly transitionNotice?: string;
}): React.ReactElement {
  const { state, error: connError, historyRevision } = useClient(connection, retainedSnapshot, onSnapshot, onLiveEvent);
  const preferences = integration.preferences?.(connection.sessionId) ?? terminalPreferenceDefaults();
  const { columns, rows } = useTerminalSize();
  const [bangResult, setBangResult] = useState<string | null>(null);
  const [interactionOpen, setInteractionOpen] = useState(false);
  const [dismissedInteractionId, setDismissedInteractionId] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(() => interruptedNotice(state));
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
  const [rewindTargets, setRewindTargets] = useState<readonly WireRewindTarget[] | null>(null);
  // Snapshot-derived ownership leaves no gap for decision keys to land in the composer; Ctrl+G picks background requests.
  const rootInteraction = state.interactions.find((item) => item.turnId === state.activeTurnId && !item.taskId);
  const panelOpen = Boolean(picker) || taskOpen || budgetOpen || Boolean(rewindTargets);
  const foregroundInteraction =
    !interactionOpen && !panelOpen && rootInteraction?.id !== dismissedInteractionId ? rootInteraction : undefined;
  const interactionActive = interactionOpen || Boolean(foregroundInteraction);
  const confirmation = useSendConfirmation(interactionActive);
  const interactionInput = useRef<InteractionInputHandler | null>(null);
  const viewportActive = !interactionActive && !panelOpen && !confirmation.pending;
  const viewport = useCommandTranscriptViewport(state, headerHeight ?? 0, viewportActive, header, historyRevision);
  const { InputFrame, PromptMarker, LiveDivider } = useSkin();
  const theme = useTheme();
  const notifyError = (error: unknown) => setNotice(error instanceof Error ? error.message : String(error));
  const [busy, setBusy] = useState(false);
  const composerActive = !panelOpen && !confirmation.pending && !connError && !interactionActive;
  const slash = useComposerMenu(editor.value, composerActive && !editing, theme.textSubtle);
  useHarnessInput(composerActive && !busy, Boolean(state.activeTurnId), editor.value);
  const pending = useRef(false);
  const togglePlan = usePlanToggle(integration, connection, confirmation, Boolean(state.activeTurnId), setNotice);
  const composerFilter = useComposerFilter({
    composerActive,
    slash,
    turnActive: Boolean(state.activeTurnId),
    outputExpanded: viewport.expanded,
    draft: { value: editor.value, cursor: editor.cursor, replace: replaceInput },
    submit: (text) => void submit(text, images),
  });
  useInterrupt({ interrupt, connection, confirmation, state, editor, replaceInput, cancelInput, setNotice });
  useInput((input, key) => {
    if (picker) return void interactionInput.current?.(input, key);
    if (confirmation.handleKey(input, key)) return;
    if (interactionActive) return void interactionInput.current?.(input, key);
    if (taskOpen || budgetOpen || rewindTargets) return;
    if (composerActive && isShiftTab(input, key)) return togglePlan();
    if (slash.handle(key, replaceInput, openPickerFor(integration, setPicker))) return;
    if (composerActive && key.escape && viewport.expanded) return viewport.collapse();
    if (isCtrlG(input, key) && !busy) (state.interactions.length ? setInteractionOpen : setTaskOpen)(true);
    if (key.ctrl && input === 'b' && state.budgets.length && !busy) setBudgetOpen(true);
    if (key.meta && key.return && state.activeTurnId && !busy && !editing)
      void submit(editor.value, images, 'follow_up');
  });
  const executeRewind = async (targetId: string, disposition: 'edit' | 'resend') => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice(null);
    setRewindTargets(null);
    try {
      setNotice(await rewindDraft(connection, targetId, disposition));
    } catch (error) {
      notifyError(error);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const submit = async (
    input: string,
    submittedImages: ImageRef[] = images,
    delivery: WireSubmission['delivery'] = state.activeTurnId ? 'steer' : 'auto',
    confirmed = false,
  ): Promise<void> => {
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
        setBangResult(await runBangShell(integration, connection, input, attached, Boolean(state.activeTurnId)));
      } else if (input.trim() === '/tasks') setTaskOpen(true);
      else if (/^\/rewind(?:\s|$)/.test(input)) {
        const match = /^\/rewind(?:\s+(last|\d+))?(?:\s+(edit|resend))?$/.exec(input.trim());
        if (!match) throw new Error('Use /rewind [last|number] [edit|resend].');
        const targets = await listRewindTargets(connection);
        if (!targets.length) throw new Error('Nothing to rewind.');
        if (!match[1]) {
          setRewindTargets(targets);
        } else {
          const target = match[1] === 'last' ? targets.at(-1) : targets[Number(match[1]) - 1];
          if (!target) throw new Error('No turn at that number.');
          pending.current = false;
          setBusy(false);
          await executeRewind(target.id, match[2] === 'resend' ? 'resend' : 'edit');
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
        const failure = await replaceSession(connection, input.trim() as '/clear' | '/rollover', switchSession);
        if (failure !== null) {
          setNotice(failure);
          editor.accepted(input, true, []);
          return;
        }
      } else if (/^\/queue(?:\s|$)/.test(input)) {
        if (await runQueueCommand(connection, input, state.queue, queueOwners.current, startQueueEdit)) return;
      } else if (input.trim() === '/cancel') {
        setNotice(await cancelInput(connection, state.activeTurnId ?? undefined, input, submission.submittedRevision));
        return;
      } else if (pickerFor(integration, input.trim())) setPicker(pickerFor(integration, input.trim()));
      else if (input.startsWith('/')) {
        const directNotice = await directSlashCommand(connection, input);
        if (directNotice !== null) setNotice(directNotice);
        else {
          const result = await integration.command(connection, input);
          if (result.message) viewport.showMessage(result.message, input, setNotice);
          if (result.transcript) viewport.appendCommandOutput(result.transcript);
          if (result.draft) {
            restoreDraft(result.draft);
            return;
          }
          if (result.sessionId) {
            if (!switchSession) throw new Error(`Session ${result.sessionId} needs an app session switch.`);
            await switchSession(result.sessionId);
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
        if (input.startsWith('/') || input.startsWith('!')) await editor.restoreRejected(input);
        notifyError(error);
      }
    } finally {
      steerRecovery.endSubmission(submission.requestId);
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Box flexDirection="column">
      {viewport.staticTranscript}
      {viewport.text ? <Text>{viewport.text}</Text> : null}
      {viewport.paged && viewport.total > 0 && (viewport.start > 0 || !viewport.live) ? (
        <Text color={theme.textSubtle}>
          Lines {viewport.start + 1}–{viewport.end} of {viewport.total} · PgUp/PgDn or Ctrl+↑/↓
        </Text>
      ) : null}
      <Activity state={state} dialogInteractionId={foregroundInteraction?.id} notice={notice} />
      {picker ? (
        <PickerHost
          kind={picker}
          integration={integration}
          connection={connection}
          inputHandler={interactionInput}
          close={() => setPicker(null)}
          onNotice={setNotice}
          switchSession={switchSession}
        />
      ) : null}
      {budgetOpen ? (
        <BudgetPanel
          requests={state.budgets}
          onClose={() => setBudgetOpen(false)}
          onAnswer={(id, decision) => answerBudget(connection, id, decision)}
        />
      ) : null}
      {taskOpen ? (
        <TaskManager
          tasks={state.tasks}
          onClose={() => setTaskOpen(false)}
          onAction={(id, action) => controlTask(connection, id, action)}
        />
      ) : null}
      {rewindTargets ? (
        <RewindPicker
          targets={rewindTargets}
          onClose={() => setRewindTargets(null)}
          onSelect={(id, disposition) => {
            void executeRewind(id, disposition);
          }}
        />
      ) : null}
      {editing ? <Text>Editing queued message · Enter saves · /queue cancel restores draft</Text> : null}
      {interactionActive ? (
        <InteractionPanel
          key={foregroundInteraction?.id ?? 'picker'}
          interactions={state.interactions}
          width={columns}
          initialRequestId={foregroundInteraction?.id}
          inputHandler={interactionInput}
          onClose={() => {
            setDismissedInteractionId(rootInteraction?.id ?? null);
            setInteractionOpen(false);
          }}
          onCancel={
            foregroundInteraction
              ? async () => {
                  if (foregroundInteraction.kind === 'question')
                    await answerInteraction(connection, foregroundInteraction.id, { kind: 'decline' });
                  else setNotice(await cancelInput(connection, foregroundInteraction.turnId));
                }
              : undefined
          }
          onAnswer={(id, decision) => answerInteraction(connection, id, decision)}
        />
      ) : null}
      <LiveNotices connectionError={connError} transitionNotice={transitionNotice} />
      {confirmation.prompt}
      <LiveNotices notice={notice} historyError={editor.historyError} />
      {bangResult ? <BangResult result={bangResult} expanded={viewport.expanded} /> : null}
      {slash.view}
      <LiveDivider />
      <InputFrame>
        <PromptMarker mode="input" />
        <MultilineInput
          key={editor.inputKey}
          value={editor.value}
          onChange={(value) => {
            slash.reset();
            changeInput(value);
          }}
          onSubmit={(value, submittedImages) => {
            void submit(value, submittedImages);
          }}
          onBoundaryArrow={(direction) => {
            const entry = editor.navigate(direction, {
              text: editor.value,
              attachments: wireAttachments(images, otherParts, originalParts),
            });
            if (entry) restoreDraft(entry, entry.cursor);
          }}
          onCursorChange={editor.cursorChanged}
          cursorOverride={editor.cursorOverride}
          width={Math.max(1, columns - 4)}
          maxHeight={Math.max(1, rows - 8)}
          pasteThreshold={preferences.pasteThreshold}
          isActive={composerActive}
          images={images}
          onImagesChange={onImagesChange}
          enableImagePaste
          onPasteError={(reason) => setNotice(`Image paste failed: ${reason}`)}
          ignoreInput={composerFilter}
        />
      </InputFrame>
      <ComposerFooter integration={integration} state={state} active={composerActive} columns={columns} />
    </Box>
  );
}
