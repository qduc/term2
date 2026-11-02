import React, { useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { Box, Text, useInput } from 'ink';
import { MultilineInput, type ImageRef } from 'ink-prompt';
import type { TuiProps } from './integration.js';
import type { WireContent, WireRewindTarget, WireSubmission } from '../../protocol/direct-wire.js';
import { useTheme } from '../../../../source/components/theme.js';
import { useSkin } from '../../../../source/skins/SkinContext.js';
import { terminalPreferenceDefaults } from '../../host/terminal-preference-defaults.js';
import { useClient } from './use-client.js';
import { Activity, LiveNotices } from './views.js';
import { InteractionPanel } from './interaction-panel.js';
import type { InteractionInputHandler } from './interaction-input.js';
import { RewindPicker } from './rewind-picker.js';
import { TaskManager } from './task-manager.js';
import { BudgetPanel } from './budget-panel.js';
import { primaryDraft, wireAttachments } from './draft.js';
import { numberedInteractionAnswer } from './interaction-command.js';
import { useSessionComposer } from './session-composer.js';
import { useTerminalSize } from './terminal.js';
import { useTranscriptViewport } from './viewport.js';
import { useHarnessInput } from './harness-input.js';
import { replaceSession } from './replace-session.js';
import { runBridgeCommand } from './bridge-command.js';
import { useSendConfirmation } from './send-confirmation.js';
import { useSlashMenu } from './slash-menu.js';
import { ComposerFooter } from './composer-footer.js';
import {
  answerBudget,
  answerInteraction,
  cancelForeground,
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
  const { state, error: connectionError } = useClient(connection, retainedSnapshot, onSnapshot, onLiveEvent);
  const preferences = integration.preferences?.(connection.sessionId) ?? terminalPreferenceDefaults();
  const { columns, rows } = useTerminalSize();
  const [interactionOpen, setInteractionOpen] = useState(false);
  const [dismissedInteractionId, setDismissedInteractionId] = useState<string | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const {
    images,
    setImages,
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
    answerOwners,
    queueOwners,
  } = useSessionComposer(state, preferences.historySize);
  const [rewindTargets, setRewindTargets] = useState<readonly WireRewindTarget[] | null>(null);
  // Snapshot-derived ownership leaves no gap for decision keys to land in the composer; Ctrl+G picks background requests.
  const rootInteraction = state.interactions.find((item) => item.turnId === state.activeTurnId && !item.taskId);
  const foregroundInteraction =
    !interactionOpen && !taskOpen && !budgetOpen && !rewindTargets && rootInteraction?.id !== dismissedInteractionId
      ? rootInteraction
      : undefined;
  const interactionActive = interactionOpen || Boolean(foregroundInteraction);
  const confirmation = useSendConfirmation(interactionActive);
  const interactionInput = useRef<InteractionInputHandler | null>(null);
  const viewport = useTranscriptViewport(
    state,
    columns,
    rows,
    !interactionActive && !taskOpen && !budgetOpen && !rewindTargets,
  );
  const { InputFrame, PromptMarker, LiveDivider } = useSkin();
  const theme = useTheme();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const composerActive =
    !busy &&
    !confirmation.pending &&
    !connectionError &&
    !interactionActive &&
    !taskOpen &&
    !budgetOpen &&
    !rewindTargets;
  const slash = useSlashMenu(editor.value, composerActive && !editing, theme.textSubtle);
  useHarnessInput(composerActive, Boolean(state.activeTurnId), editor.value);
  const pending = useRef(false);
  interrupt.current = () => {
    if (confirmation.pending) confirmation.clear();
    else if (editor.value.length > 0) replaceInput('');
    else if (state.activeTurnId || state.interactions.length) {
      void cancelForeground(connection, state.activeTurnId ?? undefined).then(setNotice, (error) => {
        setNotice(error instanceof Error ? error.message : String(error));
      });
    } else setNotice('Press Ctrl+C again to exit');
  };
  useInput((input, key) => {
    if (confirmation.handleKey(input, key)) return;
    if (interactionActive) {
      interactionInput.current?.(input, key);
      return;
    }
    if (taskOpen || budgetOpen || rewindTargets) return;
    if (
      slash.handle(key, (command, run) => {
        replaceInput(run ? command : command + ' ');
        if (run) void submit(command, images);
      })
    )
      return;
    if (((key.ctrl && input === 'g') || input === '\x07') && !busy)
      (state.interactions.length ? setInteractionOpen : setTaskOpen)(true);
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
      const result = await sendNativeCommand(connection, { type: 'rewind', commandId: randomUUID(), targetId });
      if (result.kind !== 'finished' || result.receipt.outcome?.kind !== 'rewound') {
        setNotice(receiptNotice(result));
        return;
      }
      const content = result.receipt.outcome.draft.content;
      const draft = primaryDraft(content);
      restoreDraft(draft);
      if (disposition === 'resend') {
        const message = await previewConfirmation(connection, draft.text, draft.attachments);
        if (message !== null) {
          setNotice(`${message} Draft restored, not sent; press Enter to review and confirm.`);
          return;
        }
        await submitText(connection, draft.text, draft.attachments, 'auto');
        editor.change('');
        setImages([]);
        setOtherParts([]);
        setOriginalParts([]);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
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
    if ((!input.trim() && !submittedImages.length && !otherParts.length && !editing) || pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice(null);
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
          await queueAction(connection, 'edit', editing.id, input, changed ? parts : undefined);
          replaceInput(editing.restoreText, editing.restoreCursor);
          setImages(editing.restoreImages);
          setOtherParts(editing.restoreOther);
          setOriginalParts(editing.restoreOriginal);
          setEditing(null);
          setNotice('Queued message updated.');
          return;
        } catch (error) {
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
        if (await held(match[2], parts, () => void submit(input, submittedImages, delivery, true))) return;
        await submitText(
          connection,
          match[2],
          wireAttachments(submittedImages, otherParts, originalParts),
          match[1] === 'steer' ? 'steer' : 'follow_up',
        );
        setImages([]);
        setOtherParts([]);
        setOriginalParts([]);
      } else if (input.trim() === '/tasks') {
        setTaskOpen(true);
      } else if (/^\/rewind(?:\s|$)/.test(input)) {
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
        const match = /^\/queue\s+(resume|discard|retract|edit|clear-images)(?:\s+(\d+))?(?:\s+([\s\S]*))?$/.exec(
          input.trim(),
        );
        if (!match)
          throw new Error('Use /queue resume|discard|retract <number>|edit <number> [text]|clear-images <number>.');
        const action = match[1] as 'resume' | 'discard' | 'retract' | 'edit' | 'clear-images';
        const item = match[2] ? state.queue[Number(match[2]) - 1] : undefined;
        if ((action === 'edit' || action === 'retract' || action === 'clear-images') && !item)
          throw new Error('No queued message at that number.');
        if (item && queueOwners.current && queueOwners.current[Number(match[2]) - 1] !== item.id) {
          throw new Error('The queue changed. Check the list and re-enter your command.');
        }
        if ((action === 'resume' || action === 'discard') && match[2])
          throw new Error('This operation takes no message number.');
        if (action === 'clear-images') {
          if (!item || match[3] !== undefined) throw new Error('Use /queue clear-images <number>.');
          if (!item.content) throw new Error('Queued content is unavailable; cannot safely clear images.');
          const primary = item.content.findIndex((part) => part.type === 'text');
          await queueAction(
            connection,
            'edit',
            item.id,
            item.text,
            item.content.filter((part, index) => index !== primary && part.type !== 'image'),
          );
        } else if (action === 'edit' && item && match[3] === undefined) {
          const primary = item.content?.findIndex((part) => part.type === 'text') ?? -1;
          const parts = item.content?.filter((_part, index) => index !== primary);
          setEditing({
            id: item.id,
            restoreText: '',
            restoreCursor: 0,
            restoreImages: images,
            restoreOther: otherParts,
            restoreOriginal: originalParts,
            knownParts: parts,
          });
          restoreDraft({ text: item.text, attachments: parts ?? [] });
          setNotice(
            parts
              ? 'Editing queued input and attachments. /queue cancel restores your draft.'
              : 'Editing queued text; attachment content is unavailable. /queue cancel restores your draft.',
          );
          return;
        } else await queueAction(connection, action, item?.id, match[3]);
      } else if (input.trim() === '/cancel') {
        setNotice(await cancelForeground(connection, state.activeTurnId ?? undefined));
      } else if (input.startsWith('/')) {
        const directNotice = await directSlashCommand(connection, input);
        if (directNotice !== null) setNotice(directNotice);
        else {
          const result = await integration.command(connection, input);
          if (result.message) setNotice(result.message);
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
        if (await held(input, parts, () => void submit(input, submittedImages, delivery, true))) return;
        await submitText(connection, input, parts, delivery);
        setImages([]);
        setOtherParts([]);
        setOriginalParts([]);
      }
      // Do not add interaction answers to recallable input history.
      editor.accepted(
        input,
        !input.startsWith('/answer '),
        input.startsWith('/') && !/^\/(steer|followup)\s/.test(input)
          ? []
          : wireAttachments(submittedImages, otherParts, originalParts),
      );
      answerOwners.current = null;
      queueOwners.current = null;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <Box flexDirection="column">
      {viewport.text ? <Text>{viewport.text}</Text> : null}
      {viewport.total > 0 && (viewport.start > 0 || !viewport.live) ? (
        <Text color={theme.textSubtle}>
          Lines {viewport.start + 1}–{viewport.end} of {viewport.total} · PgUp/PgDn or Ctrl+↑/↓
        </Text>
      ) : null}
      <Activity state={state} />
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
                  else setNotice(await cancelForeground(connection, foregroundInteraction.turnId));
                }
              : undefined
          }
          onAnswer={(id, decision) => answerInteraction(connection, id, decision)}
        />
      ) : null}
      <LiveNotices connectionError={connectionError} transitionNotice={transitionNotice} />
      {confirmation.prompt}
      <LiveNotices notice={notice} historyError={editor.historyError} />
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
          ignoreInput={(input, key) =>
            !composerActive ||
            slash.owns(key) ||
            ['[I', '[O', '\x1b[I', '\x1b[O'].includes(input) ||
            key.pageUp ||
            key.pageDown ||
            (key.ctrl && (key.upArrow || key.downArrow || input === 'g' || input === 'b')) ||
            (Boolean(state.activeTurnId) && key.meta && key.return)
          }
        />
      </InputFrame>
      <ComposerFooter integration={integration} state={state} active={composerActive} columns={columns} />
    </Box>
  );
}
