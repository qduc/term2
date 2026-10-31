import React, { useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { Box, Text, useInput } from 'ink';
import { MultilineInput, type ImageRef } from 'ink-prompt';
import type { TuiConnection } from './integration.js';
import type { WireContent, WireDecision, WireRewindTarget, WireSnapshot, WireSubmission } from '../../protocol/direct-wire.js';
import { useTheme } from '../../../../source/components/theme.js';
import { useSkin } from '../../../../source/skins/SkinContext.js';
import type { TuiIntegration } from './integration.js';
import { useClient } from './use-client.js';
import { Activity } from './views.js';
import { InteractionPanel } from './interaction-panel.js';
import { RewindPicker } from './rewind-picker.js';
import { TaskManager } from './task-manager.js';
import { BudgetPanel } from './budget-panel.js';
import { restoreAttachments, wireAttachments } from './draft.js';
import { useEditor } from './editor.js';
import { useTerminalSize } from './terminal.js';
import { useTranscriptViewport } from './viewport.js';
import { answerBudget, answerInteraction, cancelForeground, commandStatus, controlTask, directSlashCommand, listRewindTargets, queueAction, receiptNotice, resetSession, sendNativeCommand, submitText, WireCommandFailure } from './commands.js';

export type { TuiIntegration } from './integration.js';
export type { TuiState, ViewUpdate, Message, ToolView, InteractionView, QueueItem, TaskView } from './state.js';
export { updateView } from './state.js';
export { submitText, cancelForeground, answerInteraction, directSlashCommand } from './commands.js';
export { projectSnapshot } from './direct-projection.js';

/**
 * Direct TUI surface. The app owns the connection and supplies host/config actions;
 * unmounting or replacing the connection unsubscribes without cancelling work.
 * Session mutations go through the direct wire and failures remain visible.
 */
export function Tui(props: {
  readonly connection: TuiConnection;
  readonly integration: TuiIntegration;
  readonly retainedSnapshot?: WireSnapshot;
  readonly onSnapshot?: (snapshot: WireSnapshot) => void;
  readonly onExit: () => void;
}): React.ReactElement {
  // Keep transition notices above the keyed per-session component.
  const [transition, setTransition] = useState<{ sessionId: string; message: string } | null>(null);
  const switchSession = props.integration.switchSession ? async (sessionId: string) => {
    const result = await props.integration.switchSession!(sessionId);
    setTransition(result && result.message ? { sessionId, message: result.message } : null);
  } : undefined;
  return <TuiSession key={props.connection.sessionId} {...props} switchSession={switchSession}
    transitionNotice={transition?.sessionId === props.connection.sessionId ? transition.message : undefined} />;
}

function TuiSession({ connection, integration, retainedSnapshot, onSnapshot, onExit, switchSession, transitionNotice }: {
  readonly connection: TuiConnection;
  readonly integration: TuiIntegration;
  readonly retainedSnapshot?: WireSnapshot;
  readonly onSnapshot?: (snapshot: WireSnapshot) => void;
  readonly onExit: () => void;
  readonly switchSession?: (sessionId: string) => Promise<void>;
  readonly transitionNotice?: string;
}): React.ReactElement {
  const { state, error: connectionError } = useClient(connection, retainedSnapshot, onSnapshot);
  const { columns, rows } = useTerminalSize();
  const [interactionOpen, setInteractionOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [images, setImages] = useState<ImageRef[]>([]);
  const [otherParts, setOtherParts] = useState<readonly WireContent[]>([]);
  const [originalParts, setOriginalParts] = useState<readonly WireContent[]>([]);
  const [rewindTargets, setRewindTargets] = useState<readonly WireRewindTarget[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; restoreText: string; restoreCursor: number; restoreImages: ImageRef[]; restoreOther: readonly WireContent[]; restoreOriginal: readonly WireContent[]; knownParts?: readonly WireContent[] } | null>(null);
  const viewport = useTranscriptViewport(state, columns, rows, !interactionOpen && !taskOpen && !budgetOpen && !rewindTargets);
  const editor = useEditor(state.messages.filter(message => message.role === 'user').map(message => ({ text: message.historyText ?? message.text, attachments: message.attachments ?? [] })));
  const { InputFrame, PromptMarker, Hints } = useSkin();
  const theme = useTheme();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const answerOwners = useRef<readonly string[] | null>(null);
  const queueOwners = useRef<readonly string[] | null>(null);
  useInput((input, key) => {
    if (key.ctrl && input === 'g' && state.interactions.length && !busy) setInteractionOpen(true);
    if (key.ctrl && input === 'b' && state.budgets.length && !busy) setBudgetOpen(true);
    if (key.meta && key.return && state.activeTurnId && !busy && !editing) void submit(editor.value, images, 'follow_up');
  }, { isActive: !interactionOpen && !taskOpen && !budgetOpen && !rewindTargets });

  const changeInput = (value: string) => {
    if (/^\/answer(?:\s|$)/.test(value)) {
      if (!answerOwners.current) answerOwners.current = state.interactions.map(item => item.id);
    } else {
      answerOwners.current = null;
    }
    if (/^\/queue(?:\s|$)/.test(value)) {
      if (!queueOwners.current) queueOwners.current = state.queue.map(item => item.id);
    } else {
      queueOwners.current = null;
    }
    editor.change(value);
  };

  const restoreDraft = (draft: { readonly text: string; readonly attachments: readonly WireContent[] }, cursor?: number) => {
    const restored = restoreAttachments(draft.attachments);
    editor.replace(draft.text, cursor); setImages(restored.images); setOtherParts(restored.other); setOriginalParts(draft.attachments);
  };
  const executeRewind = async (targetId: string, disposition: 'edit' | 'resend') => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setNotice(null); setRewindTargets(null);
    try {
      const result = await sendNativeCommand(connection, { type: 'rewind', commandId: randomUUID(), targetId });
      if (result.kind !== 'finished' || result.receipt.outcome?.kind !== 'rewound') { setNotice(receiptNotice(result)); return; }
      const content = result.receipt.outcome.draft.content;
      const primary = content.findIndex(part => part.type === 'text');
      const first = content[primary];
      const draft = { text: first?.type === 'text' ? first.text : '', attachments: content.filter((_part, index) => index !== primary) };
      restoreDraft(draft);
      if (disposition === 'resend') {
        await submitText(connection, draft.text, draft.attachments, 'auto');
        editor.change(''); setImages([]); setOtherParts([]); setOriginalParts([]);
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { pending.current = false; setBusy(false); }
  };

  const submit = async (input: string, submittedImages: ImageRef[] = images, delivery: WireSubmission['delivery'] = state.activeTurnId ? 'steer' : 'auto'): Promise<void> => {
    if ((!input.trim() && !submittedImages.length && !otherParts.length && !editing) || pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice(null);
    try {
      if (editing) {
        if (input.trim() === '/queue cancel') {
          editor.replace(editing.restoreText, editing.restoreCursor); setImages(editing.restoreImages); setOtherParts(editing.restoreOther); setOriginalParts(editing.restoreOriginal); setEditing(null); return;
        }
        try {
          const parts = wireAttachments(submittedImages, otherParts, originalParts);
          if (!editing.knownParts && parts.length) throw new Error('Queued attachments are unavailable; cannot safely replace them.');
          const changed = editing.knownParts && JSON.stringify(parts) !== JSON.stringify(editing.knownParts);
          await queueAction(connection, 'edit', editing.id, input, changed ? parts : undefined);
          editor.replace(editing.restoreText, editing.restoreCursor); setImages(editing.restoreImages); setOtherParts(editing.restoreOther); setOriginalParts(editing.restoreOriginal); setEditing(null);
          setNotice('Queued message updated.'); return;
        } catch (error) {
          if (error instanceof WireCommandFailure && error.code === 'too_late') {
            setEditing(null);
            setNotice(editing.knownParts ? 'Queued input is no longer editable. Your edited draft and attachments are preserved; review before resubmitting.' : 'Queued input is no longer editable. Your edited text is preserved, but original attachments were unavailable; review before resubmitting.'); return;
          }
          throw error;
        }
      }
      if (input.startsWith('/') && !/^\/(steer|followup)\s/.test(input) && submittedImages.length) throw new Error('Remove attachments before running a command.');
      if (input.startsWith('/answer ')) {
        const match = /^\/answer\s+(\d+)\s+(\d+)(?:\s+([\s\S]*))?$/.exec(input.trim());
        const interaction = match && state.interactions[Number(match[1]) - 1];
        const choice = interaction && match && interaction.choices[Number(match[2]) - 1];
        if (!interaction || !choice || !match) throw new Error('Use /answer <interaction number> <choice number> [text].');
        if (answerOwners.current && answerOwners.current[Number(match[1]) - 1] !== interaction.id) {
          throw new Error('The interaction list changed. Check the prompt and re-enter your answer.');
        }
        if (interaction.questions?.length) throw new Error('Use Ctrl+G to answer these structured questions.');
        let decision: WireDecision;
        switch (choice.id) {
          case 'allow':
            if (match[3]) throw new Error('Allow does not accept text.');
            decision = { kind: 'allow' }; break;
          case 'deny': decision = { kind: 'deny', ...(match[3] ? { reason: match[3] } : {}) }; break;
          case 'answer':
            if (!match[3]?.trim()) throw new Error('Enter an answer after the choice number.');
            decision = { kind: 'answer', answer: match[3] }; break;
          case 'stop':
            if (match[3]) throw new Error('Stop does not accept text.');
            decision = { kind: 'answer', answer: '', stopAfterApprovalResolution: true }; break;
          default: {
            const grant = interaction.supportedGrants?.find(value => choice.id === `grant:${value}`);
            if (!grant || match[3]) throw new Error('Unsupported interaction choice or unexpected text.');
            decision = { kind: 'grant', grant };
          }
        }
        await answerInteraction(connection, interaction.id, decision);
      } else if (/^\/(steer|followup)(?:\s|$)/.test(input)) {
        const match = /^\/(steer|followup)\s+([\s\S]*)$/.exec(input);
        if (!match || (!match[2].trim() && !submittedImages.length)) throw new Error('Enter a message after /steer or /followup.');
        await submitText(connection, match[2], wireAttachments(submittedImages, otherParts, originalParts), match[1] === 'steer' ? 'steer' : 'follow_up');
        setImages([]); setOtherParts([]); setOriginalParts([]);
      } else if (input.trim() === '/tasks') {
        setTaskOpen(true);
      } else if (/^\/rewind(?:\s|$)/.test(input)) {
        const match = /^\/rewind(?:\s+(last|\d+))?(?:\s+(edit|resend))?$/.exec(input.trim());
        if (!match) throw new Error('Use /rewind [last|number] [edit|resend].');
        const targets = await listRewindTargets(connection);
        if (!targets.length) throw new Error('Nothing to rewind.');
        if (!match[1]) { setRewindTargets(targets); }
        else {
          const target = match[1] === 'last' ? targets.at(-1) : targets[Number(match[1]) - 1];
          if (!target) throw new Error('No turn at that number.');
          pending.current = false; setBusy(false);
          await executeRewind(target.id, match[2] === 'resend' ? 'resend' : 'edit'); return;
        }
      } else if (/^\/bridge(?:\s|$)/.test(input)) {
        const tokens = input.trim().split(/\s+/).slice(1);
        const action = tokens[0] ?? 'status';
        if (!integration.bridge) throw new Error('Runtime session attachment is unavailable in this app.');
        if (!['status', 'connect', 'disconnect'].includes(action) || tokens.length > (action === 'connect' ? 2 : 1)) throw new Error('Usage: /bridge [status|connect [name]|disconnect]');
        const name = tokens[1] ?? 'coord';
        if (action === 'connect' && !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid bridge socket name. Use 1–64 letters, digits, _ or -.');
        const status = action === 'connect' ? await integration.bridge.connect(name) : action === 'disconnect' ? await integration.bridge.disconnect() : await integration.bridge.status();
        setNotice(status.attachment
          ? `Session attached: ${status.attachment.name}; local control socket ${status.attachment.socketPath}; Discord input ${status.attachment.discordInputEnabled ? 'enabled' : 'disabled'} (Discord connectivity not verified); session ${status.sessionId}${status.startup ? '; startup socket' : ''}.`
          : `Session not attached; session ${status.sessionId}. To enable remote input, use /bridge connect [name].`);
      } else if (/^\/command-(status|apply)(?:\s|$)/.test(input)) {
        const match = /^\/command-(status|apply)\s+(\S+)$/.exec(input.trim());
        if (!match) throw new Error('Use /command-status <id> or /command-apply <id>.');
        const result = await commandStatus(connection, match[2]);
        if (match[1] === 'status' || result.kind !== 'finished') { setNotice(receiptNotice(result)); }
        else {
          const outcome = result.receipt.outcome;
          if (outcome?.kind === 'rewound') {
            const primary = outcome.draft.content.findIndex(part => part.type === 'text');
            const first = outcome.draft.content[primary];
            restoreDraft({ text: first?.type === 'text' ? first.text : '', attachments: outcome.draft.content.filter((_part, index) => index !== primary) });
            setNotice('Rewind draft restored. Review before sending.'); return;
          }
          if (outcome?.kind === 'rolled_over') {
            if (!switchSession) throw new Error(`Session ${outcome.sessionId} needs an app session switch.`);
            await switchSession(outcome.sessionId);
          } else setNotice(receiptNotice(result));
        }
      } else if (input.trim() === '/clear' || input.trim() === '/rollover') {
        if (!switchSession) throw new Error('Session switching is unavailable in this app.');
        let sessionId: string;
        if (input.trim() === '/clear') sessionId = await resetSession(connection);
        else {
          const result = await sendNativeCommand(connection, { type: 'rollover', commandId: randomUUID() });
          if (result.kind !== 'finished' || result.receipt.outcome?.kind !== 'rolled_over') { setNotice(receiptNotice(result)); editor.accepted(input, true, []); return; }
          sessionId = result.receipt.outcome.sessionId;
        }
        try { await switchSession(sessionId); }
        catch (error) { throw new Error(`Session ${sessionId} was created; switching reported: ${error instanceof Error ? error.message : String(error)}`); }
      } else if (/^\/queue(?:\s|$)/.test(input)) {
        const match = /^\/queue\s+(resume|discard|retract|edit|clear-images)(?:\s+(\d+))?(?:\s+([\s\S]*))?$/.exec(input.trim());
        if (!match) throw new Error('Use /queue resume|discard|retract <number>|edit <number> [text]|clear-images <number>.');
        const action = match[1] as 'resume' | 'discard' | 'retract' | 'edit' | 'clear-images';
        const item = match[2] ? state.queue[Number(match[2]) - 1] : undefined;
        if ((action === 'edit' || action === 'retract' || action === 'clear-images') && !item) throw new Error('No queued message at that number.');
        if (item && queueOwners.current && queueOwners.current[Number(match[2]) - 1] !== item.id) {
          throw new Error('The queue changed. Check the list and re-enter your command.');
        }
        if ((action === 'resume' || action === 'discard') && match[2]) throw new Error('This operation takes no message number.');
        if (action === 'clear-images') {
          if (!item || match[3] !== undefined) throw new Error('Use /queue clear-images <number>.');
          if (!item.content) throw new Error('Queued content is unavailable; cannot safely clear images.');
          const primary = item.content.findIndex(part => part.type === 'text');
          await queueAction(connection, 'edit', item.id, item.text, item.content.filter((part, index) => index !== primary && part.type !== 'image'));
        } else if (action === 'edit' && item && match[3] === undefined) {
          const primary = item.content?.findIndex(part => part.type === 'text') ?? -1;
          const parts = item.content?.filter((_part, index) => index !== primary);
          setEditing({ id: item.id, restoreText: '', restoreCursor: 0, restoreImages: images, restoreOther: otherParts, restoreOriginal: originalParts, knownParts: parts });
          restoreDraft({ text: item.text, attachments: parts ?? [] });
          setNotice(parts ? 'Editing queued input and attachments. /queue cancel restores your draft.' : 'Editing queued text; attachment content is unavailable. /queue cancel restores your draft.'); return;
        } else await queueAction(connection, action, item?.id, match[3]);
      } else if (input.trim() === '/cancel') {
        setNotice(await cancelForeground(connection, state.activeTurnId ?? undefined));
      } else if (input.startsWith('/')) {
        const directNotice = await directSlashCommand(connection, input);
        if (directNotice !== null) setNotice(directNotice);
        else {
          const result = await integration.command(connection, input);
          if (result.message) setNotice(result.message);
          if (result.draft) { restoreDraft(result.draft); return; }
          if (result.sessionId) {
            if (!switchSession) throw new Error(`Session ${result.sessionId} needs an app session switch.`);
            await switchSession(result.sessionId);
          }
          if (result.exit) onExit();
        }
      } else {
        await submitText(connection, input, wireAttachments(submittedImages, otherParts, originalParts), delivery);
        setImages([]); setOtherParts([]); setOriginalParts([]);
      }
      // Do not add interaction answers to recallable input history.
      editor.accepted(input, !input.startsWith('/answer '), input.startsWith('/') && !/^\/(steer|followup)\s/.test(input) ? [] : wireAttachments(submittedImages, otherParts, originalParts));
      answerOwners.current = null;
      queueOwners.current = null;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return <Box flexDirection="column">
    {viewport.text ? <Text>{viewport.text}</Text> : null}
    {viewport.total > 0 && (viewport.start > 0 || !viewport.live) ?
      <Text color={theme.textSubtle}>Lines {viewport.start + 1}–{viewport.end} of {viewport.total} · PgUp/PgDn or Ctrl+↑/↓</Text> : null}
    <Activity state={state} />
    {budgetOpen ? <BudgetPanel requests={state.budgets} onClose={() => setBudgetOpen(false)} onAnswer={(id, decision) => answerBudget(connection, id, decision)} /> : null}
    {taskOpen ? <TaskManager tasks={state.tasks} onClose={() => setTaskOpen(false)} onAction={(id, action) => controlTask(connection, id, action)} /> : null}
    {rewindTargets ? <RewindPicker targets={rewindTargets} onClose={() => setRewindTargets(null)} onSelect={(id, disposition) => { void executeRewind(id, disposition); }} /> : null}
    {editing ? <Text>Editing queued message · Enter saves · /queue cancel restores draft</Text> : null}
    {interactionOpen ? <InteractionPanel interactions={state.interactions} width={columns} onClose={() => setInteractionOpen(false)}
      onAnswer={(id, decision) => answerInteraction(connection, id, decision)} /> : null}
    {connectionError ? <Text color={theme.danger}>{connectionError}</Text> : null}
    {transitionNotice ? <Text>{transitionNotice}</Text> : null}
    {notice ? <Text>{notice}</Text> : null}
    {editor.historyError ? <Text>{editor.historyError}</Text> : null}
    <InputFrame>
      <PromptMarker mode="input" />
      <MultilineInput
        key={editor.inputKey}
        value={editor.value}
        onChange={changeInput}
        onSubmit={(value, submittedImages) => { void submit(value, submittedImages); }}
        onBoundaryArrow={direction => {
          const entry = editor.navigate(direction, { text: editor.value, attachments: wireAttachments(images, otherParts, originalParts) });
          if (entry) restoreDraft(entry, entry.cursor);
        }}
        onCursorChange={editor.cursorChanged}
        cursorOverride={editor.cursorOverride}
        width={Math.max(1, columns - 4)}
        maxHeight={Math.max(1, rows - 8)}
        isActive={!busy && !connectionError && !interactionOpen && !taskOpen && !budgetOpen && !rewindTargets}
        images={images}
        onImagesChange={setImages}
        enableImagePaste
        onPasteError={reason => setNotice(`Image paste failed: ${reason}`)}
        ignoreInput={(input, key) => key.pageUp || key.pageDown || (key.ctrl && (key.upArrow || key.downArrow || input === 'g' || input === 'b')) || (Boolean(state.activeTurnId) && key.meta && key.return)}
      />
    </InputFrame>
    <Hints hints={[["Enter", state.activeTurnId ? "steer" : "send"], ["Alt+Enter", "follow-up"], ["↑/↓", "history"], ["PgUp/PgDn", "scroll"], ["Ctrl+G", "approvals"], ["Ctrl+B", "budget"], ["/tasks", "manage tasks"], ["/", "commands"], ["/cancel", "stop"]]} />
  </Box>;
}
